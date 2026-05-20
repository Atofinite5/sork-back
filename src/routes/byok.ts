import { Hono } from "hono";
import { db } from "../db/index.js";
import { byokKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { encryptKey, decryptKey } from "../lib/crypto.js";
import { z } from "zod";
import type { HonoEnv } from "../types.js";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { CohereClient } from "cohere-ai";

const byok = new Hono<HonoEnv>();

const addSchema = z.object({
  provider: z.enum(["groq", "anthropic", "nvidia", "openai", "cohere", "custom"]),
  label: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
});

// GET /byok — list keys (no decryption)
byok.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const keys = await db
    .select({
      id: byokKeys.id,
      provider: byokKeys.provider,
      label: byokKeys.label,
      baseUrl: byokKeys.baseUrl,
      model: byokKeys.model,
      active: byokKeys.active,
      createdAt: byokKeys.createdAt,
    })
    .from(byokKeys)
    .where(eq(byokKeys.userId, userId));
  return c.json({ keys });
});

// POST /byok — add key
byok.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { provider, label, apiKey, baseUrl, model } = parsed.data;
  const [inserted] = await db
    .insert(byokKeys)
    .values({ userId, provider, label, encryptedKey: encryptKey(apiKey), baseUrl, model })
    .returning({ id: byokKeys.id });

  return c.json({ id: inserted!.id, provider, label });
});

// DELETE /byok/:id
byok.delete("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const [key] = await db.select({ userId: byokKeys.userId }).from(byokKeys).where(eq(byokKeys.id, c.req.param("id"))).limit(1);
  if (!key || key.userId !== userId) return c.json({ error: "Not found" }, 404);
  await db.delete(byokKeys).where(eq(byokKeys.id, c.req.param("id")));
  return c.json({ ok: true });
});

// PATCH /byok/:id/toggle
byok.patch("/:id/toggle", async (c) => {
  const userId = c.get("userId") as string;
  const [key] = await db.select({ userId: byokKeys.userId, active: byokKeys.active }).from(byokKeys).where(eq(byokKeys.id, c.req.param("id"))).limit(1);
  if (!key || key.userId !== userId) return c.json({ error: "Not found" }, 404);
  await db.update(byokKeys).set({ active: !key.active, updatedAt: new Date() }).where(eq(byokKeys.id, c.req.param("id")));
  return c.json({ active: !key.active });
});

// GET /byok/status — live-check each key: ok | limited | error
byok.get("/status", async (c) => {
  const userId = c.get("userId") as string;

  const keys = await db
    .select({ id: byokKeys.id, provider: byokKeys.provider, encryptedKey: byokKeys.encryptedKey, model: byokKeys.model, baseUrl: byokKeys.baseUrl, active: byokKeys.active })
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId)));

  const results = await Promise.all(keys.map(async (key) => {
    if (!key.active) return { id: key.id, status: "inactive" as const };
    try {
      const raw = decryptKey(key.encryptedKey);
      let status: "ok" | "limited" | "error" = "error";

      if (key.provider === "groq") {
        const groq = new Groq({ apiKey: raw });
        const res = await groq.chat.completions.create({
          messages: [{ role: "user", content: "ping" }],
          model: key.model ?? "llama-3.1-8b-instant",
          max_tokens: 1,
        });
        status = res.choices.length > 0 ? "ok" : "error";

      } else if (key.provider === "cohere") {
        const cohere = new CohereClient({ token: raw });
        await cohere.embed({ texts: ["ping"], model: "embed-english-v3.0", inputType: "search_query" });
        status = "ok";

      } else {
        // OpenAI-compatible (anthropic, nvidia, openai, custom)
        const openai = new OpenAI({ apiKey: raw, baseURL: key.baseUrl ?? undefined });
        const res = await openai.chat.completions.create({
          messages: [{ role: "user", content: "ping" }],
          model: key.model ?? "gpt-4o-mini",
          max_tokens: 1,
        });
        status = res.choices.length > 0 ? "ok" : "error";
      }

      return { id: key.id, status };
    } catch (err: unknown) {
      const msg = (err as Error).message?.toLowerCase() ?? "";
      const status =
        msg.includes("rate") || msg.includes("limit") || msg.includes("quota") ? "limited" :
        msg.includes("auth") || msg.includes("invalid") || msg.includes("401") || msg.includes("403") ? "error" :
        "error";
      return { id: key.id, status };
    }
  }));

  return c.json({ statuses: results });
});

export default byok;
