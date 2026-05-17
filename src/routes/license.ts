import { Hono } from "hono";
import { db } from "../db/index.js";
import { licenseKeys, users, subscriptions } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { generateLicenseKey, hashKey, keyPrefix } from "../lib/license.js";
import { canIssueKey, getUserQuota } from "../lib/quota.js";

const license = new Hono();

// GET /license/list — list active keys for authenticated user
license.get("/list", async (c) => {
  const userId = c.get("userId") as string;

  const keys = await db
    .select({
      id: licenseKeys.id,
      name: licenseKeys.name,
      keyPrefix: licenseKeys.keyPrefix,
      lastUsedAt: licenseKeys.lastUsedAt,
      createdAt: licenseKeys.createdAt,
      expiresAt: licenseKeys.expiresAt,
    })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.userId, userId), isNull(licenseKeys.revokedAt)));

  return c.json({ keys });
});

// POST /license/issue — issue a new key
license.post("/issue", async (c) => {
  const userId = c.get("userId") as string;

  const [sub] = await db
    .select({ plan: subscriptions.plan })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);

  const plan = sub?.plan ?? "free";
  const ok = await canIssueKey(userId, plan);
  if (!ok) {
    return c.json({ error: "Key limit reached for your plan. Upgrade to issue more keys." }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = (body as Record<string, string>).name ?? "Default Key";

  const plainKey = generateLicenseKey();
  const hash = hashKey(plainKey);
  const prefix = keyPrefix(plainKey);

  await db.insert(licenseKeys).values({ userId, keyHash: hash, keyPrefix: prefix, name });

  return c.json({ key: plainKey, prefix, name });
});

// DELETE /license/revoke/:id
license.delete("/revoke/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const [key] = await db
    .select({ userId: licenseKeys.userId })
    .from(licenseKeys)
    .where(eq(licenseKeys.id, id))
    .limit(1);

  if (!key || key.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  await db
    .update(licenseKeys)
    .set({ revokedAt: new Date() })
    .where(eq(licenseKeys.id, id));

  return c.json({ ok: true });
});

export default license;
