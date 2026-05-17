# sork-back

SORK Cloud Backend — Hono TypeScript API server powering the SORK multi-agent security pipeline.

## Stack

- **Runtime**: Node.js 20+ / Hono
- **Database**: Neon PostgreSQL + Drizzle ORM
- **Agents**: Triage → Fix → Verify (Groq llama-3.3-70b)
- **Safety**: Nemotron-3 content safety gate
- **Memory**: Cohere embeddings (hybrid semantic + recency)
- **Auth**: Clerk (dashboard) + license key (CLI)
- **BYOK**: AES-256-GCM encrypted user-supplied API keys

## Setup

```bash
npm install
cp .env.example .env
# fill in .env values
npm run db:push
npm run dev
```

## API

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/api/scan` | License key | Run full agent pipeline |
| POST | `/api/chat` | Clerk | Chat with SORK assistant |
| GET | `/api/byok` | Clerk | List BYOK keys |
| POST | `/api/byok` | Clerk | Add BYOK key |
| DELETE | `/api/byok/:id` | Clerk | Remove BYOK key |
| GET | `/api/license/list` | Clerk | List license keys |
| POST | `/api/license/issue` | Clerk | Issue new key |
| DELETE | `/api/license/revoke/:id` | Clerk | Revoke key |
| GET | `/api/usage` | Clerk | Get quota |
| POST | `/webhooks/clerk` | Svix sig | Clerk user sync |
