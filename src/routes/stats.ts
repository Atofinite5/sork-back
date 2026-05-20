import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { db } from "../db/index.js";
import { usageEvents, licenseKeys, subscriptions } from "../db/schema.js";
import { eq, desc, sum, count, and, gte, isNull } from "drizzle-orm";
import { isAdmin } from "../lib/admin.js";

const stats = new Hono<HonoEnv>();

// GET /stats — aggregate dashboard stats for the current user
stats.get("/", async (c) => {
  const userId = c.get("userId") as string;

  const [agg] = await db
    .select({
      totalScans:    count(),
      issuesFound:   sum(usageEvents.issuesFound),
      issuesFixed:   sum(usageEvents.issuesFixed),
      criticalCount: sum(usageEvents.criticalCount),
      highCount:     sum(usageEvents.highCount),
      mediumCount:   sum(usageEvents.mediumCount),
      lowCount:      sum(usageEvents.lowCount),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.status, "ok")));

  const totalFound = Number(agg?.issuesFound ?? 0);
  const totalFixed = Number(agg?.issuesFixed ?? 0);
  const fixRate    = totalFound > 0 ? Math.round((totalFixed / totalFound) * 100) : 100;

  // Quality score: starts at 100, penalised by critical/high density
  const critical   = Number(agg?.criticalCount ?? 0);
  const high       = Number(agg?.highCount ?? 0);
  const scans      = Number(agg?.totalScans ?? 0);
  const qualityScore = scans === 0
    ? 100
    : Math.max(0, Math.min(100, Math.round(100 - (critical * 15 + high * 5) / Math.max(scans, 1))));

  // Last 7 days activity (daily scan counts)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select({
      createdAt:   usageEvents.createdAt,
      issuesFound: usageEvents.issuesFound,
      issuesFixed: usageEvents.issuesFixed,
      status:      usageEvents.status,
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, sevenDaysAgo)))
    .orderBy(desc(usageEvents.createdAt));

  // Bucket by day
  const dailyMap: Record<string, { scans: number; found: number; fixed: number }> = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    dailyMap[key] = { scans: 0, found: 0, fixed: 0 };
  }
  for (const row of recent) {
    const key = row.createdAt.toISOString().slice(0, 10);
    if (dailyMap[key]) {
      dailyMap[key].scans++;
      dailyMap[key].found += Number(row.issuesFound ?? 0);
      dailyMap[key].fixed += Number(row.issuesFixed ?? 0);
    }
  }
  const activity = Object.entries(dailyMap).map(([date, v]) => ({ date, ...v }));

  // Top files by issue count
  const topFiles = await db
    .select({
      fileName:    usageEvents.fileName,
      language:    usageEvents.language,
      issuesFound: sum(usageEvents.issuesFound),
      scans:       count(),
    })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.status, "ok")))
    .groupBy(usageEvents.fileName, usageEvents.language)
    .orderBy(desc(sum(usageEvents.issuesFound)))
    .limit(8);

  return c.json({
    totalScans:   scans,
    issuesFound:  totalFound,
    issuesFixed:  totalFixed,
    fixRate,
    qualityScore,
    critical:     Number(agg?.criticalCount ?? 0),
    high:         Number(agg?.highCount ?? 0),
    medium:       Number(agg?.mediumCount ?? 0),
    low:          Number(agg?.lowCount ?? 0),
    activity,
    topFiles: topFiles.map(f => ({
      fileName:    f.fileName ?? "unknown",
      language:    f.language ?? "unknown",
      issuesFound: Number(f.issuesFound ?? 0),
      scans:       Number(f.scans),
    })),
  });
});

// GET /stats/history — recent scan history
stats.get("/history", async (c) => {
  const userId = c.get("userId") as string;
  const limit  = Math.min(Number(c.req.query("limit") ?? 20), 50);

  const history = await db
    .select({
      id:          usageEvents.id,
      fileName:    usageEvents.fileName,
      language:    usageEvents.language,
      issuesFound: usageEvents.issuesFound,
      issuesFixed: usageEvents.issuesFixed,
      criticalCount: usageEvents.criticalCount,
      highCount:   usageEvents.highCount,
      status:      usageEvents.status,
      model:       usageEvents.model,
      createdAt:   usageEvents.createdAt,
      keyPrefix:   licenseKeys.keyPrefix,
    })
    .from(usageEvents)
    .leftJoin(licenseKeys, eq(usageEvents.licenseKeyId, licenseKeys.id))
    .where(eq(usageEvents.userId, userId))
    .orderBy(desc(usageEvents.createdAt))
    .limit(limit);

  return c.json({ history });
});

// GET /stats/keys-usage — Pro/Pro+: per-key breakdown
stats.get("/keys-usage", async (c) => {
  const userId  = c.get("userId") as string;
  const clerkId = c.get("clerkId") as string;

  // Check plan
  const [sub] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const plan = sub?.plan ?? "free";
  if (plan === "free" && !isAdmin(clerkId)) {
    return c.json({ error: "Pro plan required for per-key analytics." }, 403);
  }

  const keys = await db
    .select({
      id:          licenseKeys.id,
      name:        licenseKeys.name,
      keyPrefix:   licenseKeys.keyPrefix,
      lastUsedAt:  licenseKeys.lastUsedAt,
      createdAt:   licenseKeys.createdAt,
    })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.userId, userId), isNull(licenseKeys.revokedAt)));

  const result = await Promise.all(keys.map(async (key) => {
    const [agg] = await db
      .select({
        totalScans:  count(),
        issuesFound: sum(usageEvents.issuesFound),
        issuesFixed: sum(usageEvents.issuesFixed),
      })
      .from(usageEvents)
      .where(eq(usageEvents.licenseKeyId, key.id));

    return {
      ...key,
      totalScans:  Number(agg?.totalScans ?? 0),
      issuesFound: Number(agg?.issuesFound ?? 0),
      issuesFixed: Number(agg?.issuesFixed ?? 0),
    };
  }));

  return c.json({ keys: result, plan });
});

export default stats;
