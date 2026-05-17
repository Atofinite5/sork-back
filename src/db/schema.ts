import { pgTable, uuid, text, timestamp, pgEnum, integer, decimal, boolean } from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["free", "pro", "pro_plus"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "trialing", "active", "past_due", "canceled", "incomplete", "incomplete_expired", "unpaid",
]);
export const usageStatusEnum = pgEnum("usage_status", ["ok", "rate_limited", "error"]);
export const byokProviderEnum = pgEnum("byok_provider", ["groq", "anthropic", "nvidia", "openai", "cohere", "custom"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  status: subscriptionStatusEnum("status").default("active"),
  plan: planEnum("plan").default("free"),
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const licenseKeys = pgTable("license_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  name: text("name").default("Default Key"),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// BYOK: user-supplied external API endpoints
export const byokKeys = pgTable("byok_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: byokProviderEnum("provider").notNull(),
  label: text("label").notNull(),
  encryptedKey: text("encrypted_key").notNull(),
  baseUrl: text("base_url"),
  model: text("model"),
  active: boolean("active").default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Hybrid memory: per-user conversation + embedding store
export const agentMemory = pgTable("agent_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(), // user | assistant | system
  content: text("content").notNull(),
  embedding: text("embedding"), // JSON-serialized float array from Cohere
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const usageEvents = pgTable("usage_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  licenseKeyId: uuid("license_key_id").references(() => licenseKeys.id),
  provider: text("provider"),
  model: text("model"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).default("0"),
  status: usageStatusEnum("status").default("ok"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
