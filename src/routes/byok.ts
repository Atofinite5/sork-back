import { Hono } from "hono";
import { db } from "../db/index.js";
import { byokKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { encryptKey, decryptKey } from "../lib/crypto.js";
import { z } from "zod";

const byok = new Hono();

const addSchema = z.object({
  provider: z.enum(["groq", "anthropic", "nvidia", "openai", "cohere", "custom"]),
  label: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
});

// GET /byok — list user's BYOK keys (never returns decrypted key)
byok.get("/", async (c) => {
  const userId = c.get("userId") as string;
  const keys = await db
    .select({
      id: byokKeys.id,
      provider: byokKeys.provider,
      label: byokKeys.label,
      baseUrl: byokKeys.baseUrl,
      model: byokKeys.model,
      active: byokKeys.active,
      createdAt: byokKeys.createdAt,
    })
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId)));

  return c.json({ keys });
});

// POST /byok — add a new BYOK key
byok.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = addSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400);
  }

  const { provider, label, apiKey, baseUrl, model } = parsed.data;
  const encryptedKey = encryptKey(apiKey);

  const [inserted] = await db
    .insert(byokKeys)
    .values({ userId, provider, label, encryptedKey, baseUrl, model })
    .returning({ id: byokKeys.id });

  return c.json({ id: inserted!.id, provider, label });
});

// DELETE /byok/:id
byok.delete("/:id", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const [key] = await db
    .select({ userId: byokKeys.userId })
    .from(byokKeys)
    .where(eq(byokKeys.id, id))
    .limit(1);

  if (!key || key.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.delete(byokKeys).where(eq(byokKeys.id, id));
  return c.json({ ok: true });
});

// PATCH /byok/:id/toggle
byok.patch("/:id/toggle", async (c) => {
  const userId = c.get("userId") as string;
  const id = c.req.param("id");

  const [key] = await db
    .select({ userId: byokKeys.userId, active: byokKeys.active })
    .from(byokKeys)
    .where(eq(byokKeys.id, id))
    .limit(1);

  if (!key || key.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.update(byokKeys).set({ active: !key.active, updatedAt: new Date() }).where(eq(byokKeys.id, id));
  return c.json({ active: !key.active });
});

export default byok;
