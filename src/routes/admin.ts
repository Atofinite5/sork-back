import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { db } from "../db/index.js";
import { users, subscriptions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { isAdmin } from "../lib/admin.js";
import { z } from "zod";

const admin = new Hono<HonoEnv>();

const upgradeSchema = z.object({
  email: z.string().email(),
  plan: z.enum(["free", "pro", "pro_plus"]),
});

// POST /admin/upgrade — manually upgrade a user by email
admin.post("/upgrade", async (c) => {
  const clerkId = c.get("clerkId") as string;
  if (!isAdmin(clerkId)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json();
  const parsed = upgradeSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { email, plan } = parsed.data;

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) return c.json({ error: "User not found" }, 404);

  await db
    .insert(subscriptions)
    .values({ userId: user.id, plan, status: "active" })
    .onConflictDoUpdate({
      target: subscriptions.userId,
      set: { plan, status: "active", updatedAt: new Date() },
    });

  return c.json({ ok: true, email, plan });
});

export default admin;
