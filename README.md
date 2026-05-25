# sork-back

**SORK Cloud Backend -- the AI DevSecOps engine.**

Hono TypeScript API powering the multi-agent security pipeline, cross-scan memory, fix learning, GitHub integration, CI webhooks, and analytics for [sorkcloud.space](https://sorkcloud.space).

> Live: `https://sork-back.onrender.com`

---

## What this serves

- **CLI requests** -- `sork scan`, `sork fix`, `sork chat` via license key Bearer auth
- **Dashboard requests** -- chat, analytics, BYOK, GitHub, fix learning from the Next.js client via Clerk auth
- **GitHub integration** -- OAuth, repo listing, PR conflicts, AI merge resolution, AI code review
- **CI webhooks** -- GitHub Action integration with HMAC-SHA256 signature verification
- **Multi-agent orchestrator** -- routes tasks to the best available provider based on BYOK keys

---

## Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20+ - Hono |
| Database | Neon PostgreSQL + Drizzle ORM |
| AI routing | SORK Engine multi-tier router (fast / deep / embed tiers) |
| Safety gate | Content safety guardrails |
| GitHub API | Octokit |
| Auth (CLI) | Custom JWT license keys |
| Auth (web) | Clerk session tokens |
| Encryption | AES-256-GCM for BYOK keys |
| Hosting | Render |

---

## Multi-tier model router

`src/lib/router.ts` picks the best provider per task based on user's active BYOK keys:

| Task | Tier | Fallback behavior |
|---|---|---|
| `chat` | Fast tier | Routes to fastest available provider, falls back to inbuilt |
| `embed` | Embed tier | Uses embedding provider for memory and similarity search |
| `heavy` | Deep tier | Routes to most capable model for complex analysis |
| `safety` | Safety tier | Content safety screening before any agent runs |

If BYOK fails, the router auto-falls back to inbuilt providers and tells the user in the chat.

```ts
import { callLLM } from "./lib/router.js";

const r = await callLLM(userId, "heavy", messages, { temperature: 0.1 });
// Routes to user's best available provider, or falls back to inbuilt
```

---

## Key features

### Cross-scan vulnerability memory (NEW)

SORK tracks recurring vulnerability patterns across all your scans:

- **Pattern tracking**: hashes each vulnerability signature and counts occurrences across files
- **Trend detection**: identifies patterns that keep reoccurring ("SQL injection found 12 times across 8 files")
- **Pattern insights**: generates actionable intelligence from your scan history
- **Semantic search**: find similar past vulnerabilities using embeddings

### Fix learning engine (NEW)

Learns from user edits to AI-proposed fixes:

- **Edit classification**: accepted / minor_tweak / partial_override / major_override / full_rewrite
- **Pattern extraction**: detects preferences like "prefers bcrypt over argon2", "always uses DOMPurify"
- **Preference model**: per-user, per-category confidence scoring
- **Adaptive fixes**: future fix proposals incorporate learned preferences via prompt injection

### Auto test generation (NEW)

After fix + verify pipeline, generates runnable regression tests:

- Proves the vulnerability EXISTS in the original code
- Proves it's ELIMINATED in the fixed code
- Verifies no business logic was broken
- Auto-detects language and picks framework (vitest, jest, pytest, go test, JUnit, Rust)

### GitHub Action CI (NEW)

PR-level security scanning as a GitHub Action:

- HMAC-SHA256 webhook signature verification
- Async background scan processing
- Structured PR comment with severity table
- Configurable fail thresholds (critical, high)

---

## API surface

### CLI auth (license key Bearer)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/scan` | Full pipeline scan (Safety - Triage - Fix - Verify) |
| POST | `/api/scan/sast` | Static analysis |
| POST | `/api/scan/secrets` | Hardcoded secret detection |
| POST | `/api/scan/dependencies` | CVE + outdated package scan |
| POST | `/api/scan/iac` | Dockerfile / K8s / Terraform misconfig |
| POST | `/api/scan/licenses` | GPL / AGPL compliance |
| POST | `/api/scan/quality` | Code smell + complexity |
| POST | `/api/cli/chat` | Interactive CLI chat (same harness as dashboard) |

### Dashboard auth (Clerk session)

**License keys**
- `GET /api/license/list`
- `POST /api/license/issue`
- `DELETE /api/license/revoke/:id`

**BYOK credentials**
- `GET /api/byok/list`
- `POST /api/byok/add`
- `GET /api/byok/status` -- pings each key for health check (`ok` / `limited` / `error`)
- `PATCH /api/byok/:id` -- toggle active
- `DELETE /api/byok/:id`

**Chat**
- `POST /api/chat` -- multi-agent chat with intent detection
- `POST /api/chat/stream` -- SSE streaming chat (real-time agent steps + content)
- `GET /api/chat/model` -- get user's current preferred model

**Fix learning**
- `POST /api/fixlearn/edit` -- record user's edit to an AI fix
- `GET /api/fixlearn/preferences` -- get learned fix preferences
- `GET /api/fixlearn/history` -- recent fix edit history
- `GET /api/fixlearn/insights` -- pattern intelligence + recurring patterns

**Analytics**
- `GET /api/stats` -- aggregate (totalScans, fixRate, qualityScore, severity counts, 7-day activity, top files)
- `GET /api/stats/history` -- paginated scan history
- `GET /api/stats/keys-usage` -- Pro-only per-key breakdown

**Usage / quota**
- `GET /api/usage` -- plan, limit, used, remaining

### GitHub integration

| Route | Purpose |
|---|---|
| `GET /api/github/oauth/init` | Generate GitHub authorize URL |
| `GET /api/github/oauth/callback` | OAuth exchange + token storage |
| `GET /api/github/status` | Connection status + username |
| `DELETE /api/github/disconnect` | Remove GitHub connection |
| `GET /api/github/repos` | List user's repos via Octokit |
| `GET /api/github/repos/:owner/:repo/pulls` | List open PRs with conflict detection |
| `GET /api/github/repos/:owner/:repo/pulls/:n/conflicts` | File-level conflict content |
| `POST /api/github/repos/:owner/:repo/scan` | Full repo security scan |
| `POST /api/github/repos/:owner/:repo/pulls/:n/review` | AI PR code review |
| `POST /api/github/resolve/ai` | AI merge conflict resolution (deep tier) |
| `POST /api/github/resolve/push` | Commit resolved file back to PR branch |

### CI integration

| Route | Auth | Purpose |
|---|---|---|
| `POST /ci/setup` | Clerk | Register webhook for a repo, generates secret |
| `POST /ci/webhook/:id` | HMAC-SHA256 | GitHub webhook receiver |
| `POST /api/ci/scan` | License key | Direct scan endpoint for GitHub Action |
| `GET /api/ci/runs` | Clerk | List scan runs |
| `GET /api/ci/webhooks` | Clerk | List configured webhooks |

### Multi-agent orchestrator

- `POST /api/agent/scan` -- 4-stage pipeline (embed - fast triage - deep review - summary)
- `POST /api/agent/heavy` -- single-file deep analysis
- `GET  /api/agent/status` -- which providers user has wired

### Webhooks (no auth, svix-verified)

- `POST /webhooks/clerk` -- auto-creates users when Clerk webhook fires

---

## Database schema

Tables managed by Drizzle ORM (`src/db/schema.ts`):

**Core**
- `users` - `subscriptions` - `license_keys` - `usage_events`
- `byok_keys` (AES-256-GCM encrypted) - `agent_memory` (hybrid semantic + recency)

**DevSecOps engine**
- `github_connections` -- encrypted OAuth tokens
- `repositories` -- synced GitHub repo metadata
- `pull_requests` -- PR state + conflict counts
- `merge_conflicts` -- file-level conflict state + AI resolution
- `scan_jobs` -- async scan tracking

**Cross-scan memory (NEW)**
- `vuln_patterns` -- recurring vulnerability tracking with embeddings, occurrence counts, unique constraint on (userId, patternHash)
- `scan_snapshots` -- historical triage/fix snapshots for trend analysis

**Fix learning (NEW)**
- `fix_edits` -- every user edit to an AI fix (aiCode, userCode, category, editType, pattern)
- `fix_preferences` -- learned per-user, per-category preferences with confidence scores

**CI integration (NEW)**
- `ci_webhooks` -- registered GitHub webhook configs with HMAC secrets
- `ci_scan_runs` -- PR scan results, commit SHAs, finding counts

Migrations run automatically on startup via `src/db/migrate.ts` (Neon HTTP).

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

# AI providers (inbuilt defaults -- used as fallback)
# Configure via BYOK in dashboard for user-specific routing

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
npm run dev                 # -> http://localhost:8080
```

### Type check

```bash
npm run type-check          # tsc --noEmit
```

### Production build

```bash
npm run build               # tsc -> dist/
npm start                   # node dist/index.js
```

---

## Project structure

```
src/
+-- index.ts                # Hono app + middleware + route registration
+-- types.ts                # HonoEnv typing for c.get("userId")
+-- db/
|   +-- index.ts            # Drizzle client
|   +-- schema.ts           # All tables (core + devsecops + memory + learning + CI)
|   +-- migrate.ts          # Startup migration (idempotent CREATE IF NOT EXISTS)
+-- middleware/
|   +-- auth.ts             # licenseAuth (Bearer) + clerkAuth (session)
+-- lib/
|   +-- router.ts           # Multi-tier model router (resolveProvider, callLLM, callEmbed)
|   +-- harness.ts          # Multi-agent chat harness (intent + RAG + agents + fix pipeline)
|   +-- scanMemory.ts       # Cross-scan vulnerability memory (pattern tracking + insights)
|   +-- fixLearning.ts      # Fix learning engine (edit classification + preferences)
|   +-- testGen.ts          # Auto security test generation (post fix+verify)
|   +-- crypto.ts           # encryptKey / decryptKey (AES-256-GCM)
|   +-- parseJson.ts        # Robust JSON extraction from LLM responses
|   +-- quota.ts            # Plan limit enforcement
|   +-- admin.ts            # Admin user check
|   +-- license.ts          # JWT license key sign / verify
|   +-- providers/          # Direct provider wrappers
+-- agents/
|   +-- memory.ts           # Hybrid memory store (embeddings + recency)
+-- routes/
    +-- scan.ts             # Main pipeline (CLI license auth)
    +-- scantypes.ts        # SAST, secrets, dependencies, IaC, licenses, quality
    +-- chat.ts             # Chat (dashboard + CLI, uses harness)
    +-- byok.ts             # BYOK management + live status check
    +-- license.ts          # License key issuance
    +-- usage.ts            # Quota
    +-- stats.ts            # Analytics aggregates
    +-- github.ts           # GitHub OAuth + repos + PRs + merge conflicts
    +-- agent.ts            # Multi-agent /scan /heavy /status
    +-- fixlearn.ts         # Fix learning API (edit, preferences, history, insights)
    +-- ci.ts               # CI integration (setup, webhooks, scan runs)
    +-- admin.ts            # Admin-only endpoints
    +-- webhooks.ts         # Clerk webhook handler

github-action/
+-- action.yml              # Composite GitHub Action for PR scanning
+-- example-workflow.yml    # Example workflow for users
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
    buildCommand: npm install && npm run build
    startCommand: node dist/index.js
    healthCheckPath: /health
```

After every deploy, `runMigrations()` runs on startup -- safe to re-run (uses `CREATE IF NOT EXISTS`).

---

## Security

- **License keys**: JWT signed with `JWT_SECRET`, prefix-hashed in DB
- **BYOK keys**: AES-256-GCM encrypted at rest, decrypted only at call time
- **GitHub tokens**: stored encrypted in `github_connections`
- **CI webhooks**: HMAC-SHA256 signature verification, rejects missing signatures
- **CORS**: allowed origins explicitly listed (`sorkcloud.space`, `www.sorkcloud.space`, `localhost:3000`)
- **Code scanning**: submitted code is never persisted -- only metadata
- **Memory**: embeddings store snippets only, not full files

---

## Branches

- `main` -- production, Render auto-deploys
- `dev` -- active development, PRs merge to main

---

## Repos

| Repo | Stack | Where |
|---|---|---|
| **sork-back** (this) | Hono - Drizzle - Neon | Render |
| [sork-client](https://github.com/Atofinite5/sork-client) | Next.js 15 | Vercel - `sorkcloud.space` |
| sork-cli | Node npm package | `npm i -g sork-cli` |

---

## Built by

Bhargav Kalambhe -- [Atofinite5](https://github.com/Atofinite5)

Powered by SORK Engine -- multi-tier AI routing
