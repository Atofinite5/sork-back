import { pgTable, uuid, text, timestamp, pgEnum, integer, decimal, boolean, jsonb } from "drizzle-orm/pg-core";

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
  preferredModel: text("preferred_model").default("llama-3.3-70b-versatile"),
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
  // Scan analytics
  language: text("language"),
  filesScanned: integer("files_scanned").default(1),
  issuesFound: integer("issues_found").default(0),
  issuesFixed: integer("issues_fixed").default(0),
  criticalCount: integer("critical_count").default(0),
  highCount: integer("high_count").default(0),
  mediumCount: integer("medium_count").default(0),
  lowCount: integer("low_count").default(0),
  fileName: text("file_name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ─── DevSecOps Engine — new tables ─────────────────── */

export const githubConnections = pgTable("github_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  githubUserId: text("github_user_id").notNull(),
  githubUsername: text("github_username").notNull(),
  githubEmail: text("github_email"),
  accessToken: text("access_token").notNull(),
  scope: text("scope"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const repositories = pgTable("repositories", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  githubId: text("github_id").notNull(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  isPrivate: boolean("is_private").default(false),
  defaultBranch: text("default_branch").default("main"),
  language: text("language"),
  description: text("description"),
  stars: integer("stars").default(0),
  openPrCount: integer("open_pr_count").default(0),
  lastSyncedAt: timestamp("last_synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const pullRequests = pgTable("pull_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  repositoryId: uuid("repository_id").notNull().references(() => repositories.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  githubPrNumber: integer("github_pr_number").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  author: text("author"),
  sourceBranch: text("source_branch").notNull(),
  targetBranch: text("target_branch").notNull(),
  state: text("state").default("open"),
  mergeable: boolean("mergeable"),
  conflictCount: integer("conflict_count").default(0),
  resolvedCount: integer("resolved_count").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const mergeConflicts = pgTable("merge_conflicts", {
  id: uuid("id").primaryKey().defaultRandom(),
  pullRequestId: uuid("pull_request_id").notNull().references(() => pullRequests.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  language: text("language"),
  baseCode: text("base_code"),
  currentCode: text("current_code"),
  incomingCode: text("incoming_code"),
  resolvedCode: text("resolved_code"),
  resolution: text("resolution"), // current | incoming | both | ai | manual
  aiConfidence: text("ai_confidence"),
  aiExplanation: text("ai_explanation"),
  status: text("status").default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const scanJobs = pgTable("scan_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
  type: text("type").notNull(), // sast | secrets | dependencies | iac | full
  status: text("status").default("pending"),
  findings: integer("findings").default(0),
  critical: integer("critical").default(0),
  high: integer("high").default(0),
  medium: integer("medium").default(0),
  low: integer("low").default(0),
  report: text("report"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});

/* ─── Cross-Scan Security Memory ─────────────────── */

export const vulnPatterns = pgTable("vuln_patterns", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  patternHash: text("pattern_hash").notNull(),
  category: text("category").notNull(),
  cwe: text("cwe"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  fixHint: text("fix_hint"),
  severity: text("severity").notNull(),
  occurrences: integer("occurrences").default(1),
  filesAffected: jsonb("files_affected").$type<string[]>().default([]),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),
  embedding: text("embedding"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const scanSnapshots = pgTable("scan_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sessionId: text("session_id"),
  fileName: text("file_name"),
  language: text("language"),
  codeHash: text("code_hash").notNull(),
  issueIds: jsonb("issue_ids").$type<string[]>().default([]),
  triageJson: jsonb("triage_json"),
  fixApplied: boolean("fix_applied").default(false),
  fixJson: jsonb("fix_json"),
  verifyScore: integer("verify_score"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

/* ─── Fix Learning — user edit preferences ─────────── */

export const fixEdits = pgTable("fix_edits", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  patternId: uuid("pattern_id").references(() => vulnPatterns.id, { onDelete: "set null" }),
  category: text("category").notNull(),
  severity: text("severity").notNull(),
  aiProposedCode: text("ai_proposed_code").notNull(),
  userFinalCode: text("user_final_code").notNull(),
  diffDelta: text("diff_delta"),
  editType: text("edit_type").notNull(),
  embedding: text("embedding"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const fixPreferences = pgTable("fix_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  preferredPattern: text("preferred_pattern").notNull(),
  confidence: integer("confidence").default(50),
  sampleCount: integer("sample_count").default(1),
  lastAppliedAt: timestamp("last_applied_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/* ─── CI/CD Webhook Integration ────────────────────── */

export const ciWebhooks = pgTable("ci_webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
  webhookSecret: text("webhook_secret").notNull(),
  active: boolean("active").default(true),
  events: jsonb("events").$type<string[]>().default(["pull_request"]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ciScanRuns = pgTable("ci_scan_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id").notNull().references(() => ciWebhooks.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  prNumber: integer("pr_number"),
  commitSha: text("commit_sha").notNull(),
  branch: text("branch").notNull(),
  status: text("status").default("pending"),
  findings: integer("findings").default(0),
  critical: integer("critical").default(0),
  high: integer("high").default(0),
  reportUrl: text("report_url"),
  commentId: text("comment_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
});
