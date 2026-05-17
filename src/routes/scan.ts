import { Hono } from "hono";
import { runPipeline } from "../agents/orchestrator.js";
import { saveMemory } from "../agents/memory.js";
import { db } from "../db/index.js";
import { usageEvents, licenseKeys } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashKey } from "../lib/license.js";
import { getUserQuota } from "../lib/quota.js";
import { z } from "zod";
import { randomUUID } from "crypto";

const scan = new Hono();

const scanSchema = z.object({
  code: z.string().min(1).max(100_000),
  context: z.string().optional(),
  sessionId: z.string().optional(),
});

// POST /scan — run the full agent pipeline
scan.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const licenseKeyId = c.get("licenseKeyId") as string | undefined;

  // Quota check
  const quota = await getUserQuota(userId);
  if (quota.exhausted) {
    return c.json(
      {
        error: "Free quota exhausted. Upgrade at sorkcloud.space/pricing",
        quota,
      },
      402
    );
  }

  const body = await c.req.json();
  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { code, context, sessionId = randomUUID() } = parsed.data;

  // Save user message to memory
  await saveMemory(userId, sessionId, "user", code.slice(0, 500));

  const start = Date.now();
  const result = await runPipeline({ userId, sessionId, code, context });
  const duration = Date.now() - start;

  // Log usage
  await db.insert(usageEvents).values({
    userId,
    licenseKeyId: licenseKeyId ?? undefined,
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    status: result.blocked ? "error" : "ok",
  });

  return c.json(
    {
      ...result,
      sessionId,
      duration,
      quota: await getUserQuota(userId),
    },
    200,
    {
      "x-sork-session": sessionId,
      "x-sork-duration": String(duration),
    }
  );
});

export default scan;
