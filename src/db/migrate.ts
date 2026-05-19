import { neon } from "@neondatabase/serverless";

export async function runMigrations(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);

  // Enums
  await sql`DO $$ BEGIN CREATE TYPE IF NOT EXISTS plan AS ENUM ('free','pro','pro_plus'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE IF NOT EXISTS subscription_status AS ENUM ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE IF NOT EXISTS usage_status AS ENUM ('ok','rate_limited','error'); EXCEPTION WHEN duplicate_object THEN null; END $$`;
  await sql`DO $$ BEGIN CREATE TYPE IF NOT EXISTS byok_provider AS ENUM ('groq','anthropic','nvidia','openai','cohere','custom'); EXCEPTION WHEN duplicate_object THEN null; END $$`;

  // Core tables
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

  // New tables
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

  console.log("Migrations complete ✓");
}
