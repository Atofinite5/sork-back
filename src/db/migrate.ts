import { neon } from "@neondatabase/serverless";

export async function runMigrations(): Promise<void> {
  const sql = neon(process.env.DATABASE_URL!);

  await sql`
    DO $$ BEGIN
      CREATE TYPE IF NOT EXISTS byok_provider AS ENUM ('groq','anthropic','nvidia','openai','cohere','custom');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
  `;

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
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );
  `;

  // Add expires_at to license_keys if it doesn't exist
  await sql`
    ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
  `;

  console.log("Migrations complete ✓");
}
