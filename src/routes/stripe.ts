import { Hono } from "hono";
import Stripe from "stripe";
import { db } from "../db/index.js";
import { subscriptions, users } from "../db/schema.js";
import { eq } from "drizzle-orm";

const stripe = new Hono();

const PRICE_TO_PLAN: Record<string, "pro" | "pro_plus"> = {
  [process.env.STRIPE_PRICE_PRO ?? ""]: "pro",
  [process.env.STRIPE_PRICE_PRO_PLUS ?? ""]: "pro_plus",
};

stripe.post("/webhook", async (c) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return c.json({ error: "Stripe webhook secret not configured" }, 500);

  const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);
  const body = await c.req.text();
  const sig = c.req.header("stripe-signature") ?? "";

  let event: Stripe.Event;
  try {
    event = stripeClient.webhooks.constructEvent(body, sig, secret);
  } catch {
    return c.json({ error: "Invalid signature" }, 400);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const email = session.customer_email ?? "";
    const priceId = (session as unknown as { line_items?: { data: Array<{ price: { id: string } }> } }).line_items?.data[0]?.price?.id ?? "";
    const plan = PRICE_TO_PLAN[priceId] ?? "pro";

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (user) {
      await db
        .insert(subscriptions)
        .values({
          userId: user.id,
          stripeCustomerId: session.customer as string,
          plan,
          status: "active",
        })
        .onConflictDoUpdate({
          target: subscriptions.userId,
          set: { plan, status: "active", stripeCustomerId: session.customer as string, updatedAt: new Date() },
        });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object as Stripe.Subscription;
    await db
      .update(subscriptions)
      .set({ plan: "free", status: "canceled", updatedAt: new Date() })
      .where(eq(subscriptions.stripeCustomerId, sub.customer as string));
  }

  return c.json({ ok: true });
});

export default stripe;
