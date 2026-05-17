import { db } from "../db/index.js";
import { usageEvents, subscriptions, licenseKeys } from "../db/schema.js";
import { eq, count, and, isNull } from "drizzle-orm";

export const FREE_REQUEST_LIMIT = 14;

export const PLAN_LIMITS: Record<string, number | null> = {
  free: FREE_REQUEST_LIMIT,
  pro: null,
  pro_plus: null,
};

export async function getUserQuota(userId: string) {
  const [sub] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const plan = sub?.plan ?? "free";
  const limit = PLAN_LIMITS[plan];
  const unlimited = limit === null;

  if (unlimited) {
    return { plan, limit: null, used: 0, remaining: null, exhausted: false, unlimited: true };
  }

  const [row] = await db
    .select({ used: count() })
    .from(usageEvents)
    .where(eq(usageEvents.userId, userId));

  const used = Number(row?.used ?? 0);
  const remaining = Math.max(0, limit! - used);

  return { plan, limit, used, remaining, exhausted: remaining === 0, unlimited: false };
}

export async function getActiveKeyCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ cnt: count() })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.userId, userId), isNull(licenseKeys.revokedAt)));
  return Number(row?.cnt ?? 0);
}

export async function canIssueKey(userId: string, plan: string): Promise<boolean> {
  const maxKeys: Record<string, number> = { free: 1, pro: 5, pro_plus: 20 };
  const max = maxKeys[plan] ?? 1;
  const current = await getActiveKeyCount(userId);
  return current < max;
}
