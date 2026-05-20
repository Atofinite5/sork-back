import { neon } from "@neondatabase/serverless";

export async function runMigrations(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);

  // Enums — use exception handler since IF NOT EXISTS isn't valid for types
  await sql`DO $$ BEGIN CREATE TYPE plan AS ENUM ('free','pro','pro_plus'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE subscription_status AS ENUM ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE usage_status AS ENUM ('ok','rate_limited','error'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE byok_provider AS ENUM ('groq','anthropic','nvidia','openai','cohere','custom'); EXCEPTION WHEN duplicate_object THEN null; END $$`;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      status subscription_status DEFAULT 'active',
      plan plan DEFAULT 'free',
      current_period_end TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS license_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      name TEXT DEFAULT 'Default Key',
      expires_at TIMESTAMP,
      last_used_at TIMESTAMP,
      revoked_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS usage_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      license_key_id UUID REFERENCES license_keys(id),
      provider TEXT,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd DECIMAL(10,6) DEFAULT 0,
      status usage_status DEFAULT 'ok',
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS byok_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider byok_provider NOT NULL,
      label TEXT NOT NULL,
      encrypted_key TEXT NOT NULL,
      base_url TEXT,
      model TEXT,
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    )`;

  // New columns — users
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_model TEXT DEFAULT 'llama-3.3-70b-versatile'`;

  // New columns — usage_events analytics
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS language TEXT`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS files_scanned INTEGER DEFAULT 1`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS issues_found INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS issues_fixed INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS critical_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS high_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS medium_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS low_count INTEGER DEFAULT 0`;
  await sql`ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS file_name TEXT`;

  console.log("All tables created ✓");
}
