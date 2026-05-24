# sork-back

**SORK Cloud Backend — the AI DevSecOps engine.**

Hono TypeScript API powering the multi-agent security pipeline, GitHub integration, merge conflict resolver, and analytics for [sorkcloud.space](https://sorkcloud.space).

> Live: `https://sork-back.onrender.com`

---

## What this serves

- **CLI requests** — `sork scan`, `sork fix`, `sork verify` via license key Bearer auth
- **Dashboard requests** — chat, analytics, BYOK, GitHub from the Next.js client via Clerk auth
- **GitHub integration** — OAuth, repo listing, PR conflicts, AI merge resolution
- **Multi-agent orchestrator** — routes tasks to Groq / NVIDIA / Cohere based on BYOK keys
- **Webhooks** — Clerk user provisioning

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20+ · Hono |
| Database | Neon PostgreSQL + Drizzle ORM |
| Chat / Fast inference | Groq (llama-3.3-70b-versatile) |
| Heavy reasoning | NVIDIA NIM (Nemotron / llama-3.3-70b-instruct) |
| Embeddings | Cohere embed-english-v3.0 |
| Safety gate | Nemotron content safety |
| GitHub API | Octokit |
| Auth (CLI) | Custom JWT license keys |
| Auth (web) | Clerk session tokens |
| Encryption | AES-256-GCM for BYOK keys |
| Hosting | Render (free tier) |

---

## Multi-tier model router

`src/lib/router.ts` picks the best provider per task based on user's active BYOK keys:

| Task | Preference order | Fallback |
|---|---|---|
| `chat` | Groq → OpenAI → NVIDIA → custom | Inbuilt Groq |
| `embed` | Cohere → OpenAI | Inbuilt Cohere |
| `heavy` | NVIDIA → Anthropic → OpenAI → Groq | Inbuilt NVIDIA NIM |
| `safety` | NVIDIA Nemotron → Anthropic | Inbuilt Nemotron |

If BYOK fails → auto-falls back to inbuilt + tells user in the chat.

```ts
import { callLLM } from "./lib/router.js";

const r = await callLLM(userId, "heavy", messages, { temperature: 0.1 });
// → routes to user's NVIDIA key if active, else inbuilt NVIDIA, else inbuilt Groq
```

---

## API surface

### CLI auth (license key Bearer)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/scan` | Full pipeline scan (Safety → Triage → Fix → Verify) |
| POST | `/api/scan/sast` | Static analysis |
| POST | `/api/scan/secrets` | Hardcoded secret detection |
| POST | `/api/scan/dependencies` | CVE + outdated package scan |
| POST | `/api/scan/iac` | Dockerfile / K8s / Terraform misconfig |
| POST | `/api/scan/licenses` | GPL / AGPL compliance |
| POST | `/api/scan/quality` | Code smell + complexity |

### Dashboard auth (Clerk session)

**License keys**
- `GET /api/license/list`
- `POST /api/license/issue`
- `DELETE /api/license/revoke/:id`

**BYOK credentials**
- `GET /api/byok/list`
- `POST /api/byok/add`
- `GET /api/byok/status` — pings each key for health check (`ok` / `limited` / `error`)
- `PATCH /api/byok/:id` — toggle active
- `DELETE /api/byok/:id`

**Chat**
- `POST /api/chat` — uses router (chat or heavy mode based on query intent)
- `GET /api/chat/model` — get user's current preferred model

**Analytics**
- `GET /api/stats` — aggregate (totalScans, fixRate, qualityScore, severity counts, 7-day activity, top files)
- `GET /api/stats/history` — paginated scan history
- `GET /api/stats/keys-usage` — Pro-only per-key breakdown

**Usage / quota**
- `GET /api/usage` — plan, limit, used, remaining

### GitHub integration

| Route | Purpose |
|---|---|
| `GET /api/github/oauth/init` | Generate GitHub authorize URL |
| `GET /api/github/oauth/callback` | OAuth exchange + token storage |
| `GET /api/github/status` | Connection status + username |
| `DELETE /api/github/disconnect` | Remove GitHub connection |
| `GET /api/github/repos` | List user's repos via Octokit |
| `GET /api/github/repos/:owner/:repo/pulls` | List open PRs with conflict detection |
| `GET /api/github/repos/:owner/:repo/pulls/:n/conflicts` | File-level conflict content (current + incoming) |
| `POST /api/github/repos/:owner/:repo/scan` | Full repo security scan (up to 30 files, parallel Groq triage) |
| `POST /api/github/repos/:owner/:repo/pulls/:n/review` | AI PR code review |
| `POST /api/github/resolve/ai` | AI merge conflict resolution (heavy tier) |
| `POST /api/github/resolve/push` | Commit resolved file back to PR branch |

### Multi-agent orchestrator

- `POST /api/agent/scan` — 4-stage pipeline (Cohere embed → Groq fast triage → NVIDIA deep review → summary)
- `POST /api/agent/heavy` — single-file deep analysis via NVIDIA Nemotron
- `GET  /api/agent/status` — which providers user has wired

### Webhooks (no auth, svix-verified)

- `POST /webhooks/clerk` — auto-creates users when Clerk webhook fires

---

## Database schema

Tables managed by Drizzle ORM (`src/db/schema.ts`):

**Core**
- `users` · `subscriptions` · `license_keys` · `usage_events`
- `byok_keys` (AES-256-GCM encrypted) · `agent_memory` (hybrid semantic + recency)

**DevSecOps engine**
- `github_connections` — encrypted OAuth tokens
- `repositories` — synced GitHub repo metadata
- `pull_requests` — PR state + conflict counts
- `merge_conflicts` — file-level conflict state + AI resolution
- `scan_jobs` — async scan tracking

Migrations run automatically on startup via `src/db/migrate.ts` (Neon HTTP) — no separate migration step needed in production.

---

## Setup

### Environment variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host/sork-db?sslmode=require

# Auth
CLERK_SECRET_KEY=sk_test_...
CLERK_WEBHOOK_SECRET=whsec_...
JWT_SECRET=<32-byte hex>
ADMIN_USER_IDS=user_xxx,user_yyy

# AI providers (inbuilt defaults)
GROQ_API_KEY=gsk_...
NVIDIA_API_KEY=nvapi-...
COHERE_API_KEY=...

# GitHub OAuth
GITHUB_CLIENT_ID=Ov...
GITHUB_CLIENT_SECRET=...

# URLs
FRONTEND_URL=https://sorkcloud.space
CLIENT_ORIGIN=https://sorkcloud.space
```

### Local development

```bash
npm install
cp .env.example .env       # fill in values
npm run dev                 # → http://localhost:8080
```

### Type check

```bash
npm run type-check          # tsc --noEmit
```

### Production build

```bash
npm run build               # tsc → dist/
npm start                   # node dist/index.js
```

---

## Project structure

```
src/
├── index.ts                # Hono app + middleware + route registration
├── types.ts                # HonoEnv typing for c.get("userId")
├── db/
│   ├── index.ts            # Drizzle client
│   ├── schema.ts           # All tables
│   └── migrate.ts          # Startup migration (idempotent CREATE IF NOT EXISTS)
├── middleware/
│   └── auth.ts             # licenseAuth (Bearer) + clerkAuth (session)
├── lib/
│   ├── router.ts           # Multi-tier model router (resolveProvider, callLLM, callEmbed)
│   ├── crypto.ts           # encryptKey / decryptKey (AES-256-GCM)
│   ├── parseJson.ts        # Robust JSON extraction from LLM responses
│   ├── quota.ts            # Plan limit enforcement
│   ├── admin.ts            # Admin user check
│   ├── license.ts          # JWT license key sign / verify
│   └── providers/
│       ├── groq.ts         # Direct Groq wrapper
│       └── nemotron.ts     # Nemotron safety gate
├── agents/
│   └── memory.ts           # Hybrid memory store (Cohere embed + recency)
└── routes/
    ├── scan.ts             # Main pipeline (CLI license auth)
    ├── scantypes.ts        # SAST, secrets, dependencies, IaC, licenses, quality
    ├── chat.ts             # Dashboard chat (uses router)
    ├── byok.ts             # BYOK management + live status check
    ├── license.ts          # License key issuance
    ├── usage.ts            # Quota
    ├── stats.ts            # Analytics aggregates
    ├── github.ts           # GitHub OAuth + repos + PRs + merge conflicts
    ├── agent.ts            # Multi-agent /scan /heavy /status
    ├── admin.ts            # Admin-only endpoints
    └── webhooks.ts         # Clerk webhook handler
```

---

## Deployment (Render)

`render.yaml` declares the service. Render auto-deploys on push to `main`.

```yaml
services:
  - type: web
    name: sork-back
    runtime: node
    region: oregon
    plan: free
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /health
```

After every deploy, `runMigrations()` runs on startup — safe to re-run (uses `CREATE IF NOT EXISTS`).

---

## Security

- **License keys**: JWT signed with `JWT_SECRET`, prefix-hashed in DB so plaintext never persists
- **BYOK keys**: AES-256-GCM encrypted at rest, decrypted only at API call time
- **GitHub tokens**: stored as `access_token` in `github_connections` — should be encrypted in next iteration
- **CORS**: allowed origins explicitly listed (`sorkcloud.space`, `www.sorkcloud.space`, `localhost:3000`)
- **Code scanning**: submitted code is **never persisted** — only metadata (CWE IDs, severity, line numbers, file path)
- **Memory**: Cohere stores embeddings + short snippets, not full files

---

## Branches

`main` is the only branch. All work merges to `main` → Render auto-deploys.

---

## Repos

| Repo | Stack | Where |
|---|---|---|
| **sork-back** (this) | Hono · Drizzle · Neon | Render |
| [sork-client](https://github.com/Atofinite5/sork-client) | Next.js 15 | Vercel · `sorkcloud.space` |
| sork-cli | Node npm package | `npm i -g sork-cli` |

---

## Built by

Bhargav Kalambhe — [Atofinite5](https://github.com/Atofinite5)

Powered by Groq · Nemotron · Cohere
