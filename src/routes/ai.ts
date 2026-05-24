/**
 * /api/ai/* — CLI-facing AI endpoints (license-key Bearer auth).
 *
 * The sork-cli sends a license key (sork_live_*) → we resolve the user →
 * the router uses that user's BYOK keys (Groq/NVIDIA/Cohere) or falls back
 * to inbuilt defaults. The CLI never sees the underlying provider/model.
 */

import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { callLLM } from "../lib/router.js";
import { extractJson } from "../lib/parseJson.js";

const app = new Hono<HonoEnv>();

/** POST /api/ai/chat — generic LLM call for CLI */
app.post("/chat", async (c) => {
  const userId = c.get("userId");
  const { system, user, temperature, maxTokens, task } = await c.req.json() as {
    system?: string; user: string; temperature?: number; maxTokens?: number; task?: "chat" | "heavy";
  };

  if (!user) return c.json({ error: "Missing user prompt" }, 400);

  const t = task === "heavy" ? "heavy" : "chat";
  const r = await callLLM(
    userId,
    t,
    [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      { role: "user" as const, content: user },
    ],
    { temperature: temperature ?? 0.2, maxTokens: maxTokens ?? 4096 }
  );

  // Try to parse JSON if the response looks like it — otherwise return raw
  const trimmed = r.text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.includes("```json")) {
    const parsed = extractJson<unknown>(r.text);
    if (parsed) return c.json(parsed);
  }

  return c.json({ text: r.text });
});

/** GET /api/ai/status — what's the CLI getting routed to right now */
app.get("/status", (c) => {
  return c.json({ ok: true, engine: "sork-multi-tier", version: "1.0.0" });
});

export default app;
