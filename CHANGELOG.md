# Changelog

## v1.0.0 — Initial Release

### Added
- Hono TypeScript REST API server
- Three inbuilt AI providers: Groq (default engine), Nemotron-3 (safety gate), Cohere (embeddings)
- Three hybrid agents: Triage → Fix → Verify with shared semantic memory
- BYOK system with AES-256-GCM encryption
- Chat route with context-aware memory retrieval
- Drizzle ORM + Neon PostgreSQL schema
- Dual auth: license key (CLI) + Clerk session (dashboard)
- Usage tracking and quota enforcement
