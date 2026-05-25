import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { checkContentSafety } from "../lib/providers/nemotron.js";
import { saveMemory, getRecentMemory, searchMemory } from "../agents/memory.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "crypto";
import type { HonoEnv } from "../types.js";
import { runHarness, type HarnessResult } from "../lib/harness.js";

const chat = new Hono<HonoEnv>();

const chatSchema = z.object({
  message: z.string().min(1).max(12000),
  sessionId: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  attachedFiles: z.array(z.object({
    name: z.string(),
    content: z.string().optional(),
    size: z.number(),
  })).optional(),
  pendingFixCode: z.string().optional(),
  pendingFixTriage: z.unknown().optional(),
});

/* ── POST /chat — main harness-powered endpoint ── */
chat.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { message, sessionId = randomUUID(), attachedFiles, pendingFixCode, pendingFixTriage } = parsed.data;

  // Safety gate
  const safety = await checkContentSafety(message.slice(0, 1000));
  if (!safety.safe) {
    return c.json({ error: "Message blocked by content safety filter.", reason: safety.reason }, 400);
  }

  const result: HarnessResult = await runHarness({
    userId,
    sessionId,
    message,
    attachedFiles: attachedFiles?.filter(f => f.content).map(f => ({
      name: f.name,
      content: f.content!,
      size: f.size,
    })),
    pendingFixCode,
    pendingFixTriage,
  });

  return c.json({
    reply: result.reply,
    sessionId,
    intent: result.intent,
    steps: result.steps,
    fixProposal: result.fixProposal,
    awaitingFixConfirmation: result.awaitingFixConfirmation,
    ragContextUsed: result.ragContextUsed,
    durationMs: result.durationMs,
  });
});

/* ── POST /chat/stream — SSE streaming endpoint ── */
chat.post("/stream", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { message, sessionId = randomUUID(), attachedFiles, pendingFixCode, pendingFixTriage } = parsed.data;

  const safety = await checkContentSafety(message.slice(0, 1000));
  if (!safety.safe) {
    return c.json({ error: "Message blocked by content safety filter.", reason: safety.reason }, 400);
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({ data: JSON.stringify({ type: "session", sessionId }), event: "session" });
    await stream.writeSSE({ data: JSON.stringify({ type: "step", agent: "safety-gate", tier: "deep", status: "done" }), event: "step" });

    try {
      const result = await runHarness({
        userId,
        sessionId,
        message,
        attachedFiles: attachedFiles?.filter(f => f.content).map(f => ({
          name: f.name,
          content: f.content!,
          size: f.size,
        })),
        pendingFixCode,
        pendingFixTriage,
      });

      for (const step of result.steps) {
        await stream.writeSSE({ data: JSON.stringify({ type: "step", ...step }), event: "step" });
      }

      // Stream the reply in chunks for a typing effect
      const chunks = splitIntoChunks(result.reply, 60);
      for (const chunk of chunks) {
        await stream.writeSSE({ data: JSON.stringify({ type: "content", text: chunk }), event: "content" });
      }

      await stream.writeSSE({
        data: JSON.stringify({
          type: "done",
          intent: result.intent,
          fixProposal: result.fixProposal,
          awaitingFixConfirmation: result.awaitingFixConfirmation,
          ragContextUsed: result.ragContextUsed,
          durationMs: result.durationMs,
        }),
        event: "done",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      await stream.writeSSE({ data: JSON.stringify({ type: "error", message: msg }), event: "error" });
    }
  });
});

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + chunkSize, text.length);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > i) end = space + 1;
    }
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/* ── GET /chat/model — get user's current preferred model ── */
chat.get("/model", async (c) => {
  const userId = c.get("userId") as string;
  const [userRow] = await db
    .select({ preferredModel: users.preferredModel })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return c.json({ model: userRow?.preferredModel ?? "default" });
});

export default chat;
