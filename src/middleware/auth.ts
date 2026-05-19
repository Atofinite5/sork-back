import type { Context, Next } from "hono";
import type { HonoEnv } from "../types.js";
import { db } from "../db/index.js";
import { licenseKeys, users } from "../db/schema.js";
import { eq, and, isNull } from "drizzle-orm";
import { hashKey } from "../lib/license.js";

// Validates Bearer token (sork_live_* key) and sets userId + licenseKeyId on context
export async function licenseAuth(c: Context<HonoEnv>, next: Next) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  const token = auth.slice(7);
  const hash = hashKey(token);

  const [keyRow] = await db
    .select({
      id: licenseKeys.id,
      userId: licenseKeys.userId,
      expiresAt: licenseKeys.expiresAt,
    })
    .from(licenseKeys)
    .where(and(eq(licenseKeys.keyHash, hash), isNull(licenseKeys.revokedAt)))
    .limit(1);

  if (!keyRow) {
    return c.json({ error: "Invalid or revoked license key" }, 401);
  }

  if (keyRow.expiresAt && keyRow.expiresAt < new Date()) {
    return c.json({ error: "License key expired" }, 401);
  }

  // Update lastUsedAt (fire and forget)
  db.update(licenseKeys).set({ lastUsedAt: new Date() }).where(eq(licenseKeys.id, keyRow.id)).catch(() => {});

  c.set("userId", keyRow.userId);
  c.set("licenseKeyId", keyRow.id);

  await next();
}

// For dashboard routes authenticated via Clerk session token
export async function clerkAuth(c: Context<HonoEnv>, next: Next) {
  const clerkId = c.req.header("x-clerk-user-id");
  if (!clerkId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkId, clerkId))
    .limit(1);

  // Auto-create user if Clerk webhook hasn't fired yet
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({ clerkId, email: `${clerkId}@pending.sork` })
      .onConflictDoNothing()
      .returning({ id: users.id });
    user = created;
  }

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  c.set("userId", user.id);
  c.set("clerkId", clerkId);

  await next();
}
