import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { runPipeline } from "../agents/orchestrator.js";
import { saveMemory } from "../agents/memory.js";
import { db } from "../db/index.js";
import { usageEvents } from "../db/schema.js";
import { getUserQuota } from "../lib/quota.js";
import { z } from "zod";
import { randomUUID } from "crypto";

const scan = new Hono<HonoEnv>();

const scanSchema = z.object({
  code: z.string().min(1).max(100_000),
  context: z.string().optional(),
  sessionId: z.string().optional(),
  fileName: z.string().optional(),
  language: z.string().optional(),
});

scan.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const licenseKeyId = c.get("licenseKeyId");

  const quota = await getUserQuota(userId);
  if (quota.exhausted) {
    return c.json({ error: "Free quota exhausted. Upgrade at sorkcloud.space/pricing", quota }, 402);
  }

  const body = await c.req.json();
  const parsed = scanSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { code, context, sessionId = randomUUID(), fileName, language } = parsed.data;

  await saveMemory(userId, sessionId, "user", code.slice(0, 500));

  const start  = Date.now();
  const result = await runPipeline({ userId, sessionId, code, context });
  const duration = Date.now() - start;

  // Build analytics from triage result
  const triage = result.triage;
  const issues = triage?.issues ?? [];
  const fix    = result.fix;

  const criticalCount = issues.filter(i => i.severity === "critical").length;
  const highCount     = issues.filter(i => i.severity === "high").length;
  const mediumCount   = issues.filter(i => i.severity === "medium").length;
  const lowCount      = issues.filter(i => i.severity === "low" || i.severity === "info").length;
  const issuesFound   = issues.length;
  const issuesFixed   = fix?.patchApplied ? (fix.changes?.length ?? 0) : 0;

  await db.insert(usageEvents).values({
    userId,
    licenseKeyId: licenseKeyId ?? undefined,
    provider: "sork-engine",
    model: "auto",
    status: result.blocked ? "error" : "ok",
    language: language ?? "unknown",
    filesScanned: 1,
    issuesFound,
    issuesFixed,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    fileName: fileName ?? null,
  });

  return c.json(
    { ...result, sessionId, duration, quota: await getUserQuota(userId) },
    200,
    { "x-sork-session": sessionId, "x-sork-duration": String(duration) }
  );
});

export default scan;
