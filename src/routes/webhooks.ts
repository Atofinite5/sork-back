import { Hono } from "hono";
import { Webhook } from "svix";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";

const webhooks = new Hono();

webhooks.post("/clerk", async (c) => {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Webhook secret not configured" }, 500);

  const wh = new Webhook(secret);
  const body = await c.req.text();
  const headers = {
    "svix-id": c.req.header("svix-id") ?? "",
    "svix-timestamp": c.req.header("svix-timestamp") ?? "",
    "svix-signature": c.req.header("svix-signature") ?? "",
  };

  let event: { type: string; data: { id: string; email_addresses: Array<{ email_address: string }> } };
  try {
    event = wh.verify(body, headers) as typeof event;
  } catch {
    return c.json({ error: "Invalid signature" }, 400);
  }

  const { type, data } = event;
  const email = data.email_addresses?.[0]?.email_address ?? "";

  if (type === "user.created") {
    await db.insert(users).values({ clerkId: data.id, email }).onConflictDoNothing();
  } else if (type === "user.updated") {
    await db.update(users).set({ email, updatedAt: new Date() }).where(eq(users.clerkId, data.id));
  } else if (type === "user.deleted") {
    await db.delete(users).where(eq(users.clerkId, data.id));
  }

  return c.json({ ok: true });
});

export default webhooks;
