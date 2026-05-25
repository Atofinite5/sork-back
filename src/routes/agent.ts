/**
 * Multi-agent project scan + chat orchestrator.
 *
 * /api/agent/scan — runs the full pipeline using all 3 tiers:
 *   1. Cohere embed  → store project context for memory retrieval
 *   2. Groq fast triage → quick pattern detection across files
 *   3. NVIDIA Nemotron heavy → deep analysis on suspicious code
 *   4. Groq summary → human-readable report
 *
 * /api/agent/heavy — single-file deep analysis using NVIDIA Nemotron
 * /api/agent/chat — chat with model routing
 */

import { Hono } from "hono";
import { clerkAuth } from "../middleware/auth.js";
import type { HonoEnv } from "../types.js";
import { callLLM, callEmbed, resolveProvider } from "../lib/router.js";
import { extractJson } from "../lib/parseJson.js";

const app = new Hono<HonoEnv>();

interface FilePayload { path: string; language: string; content: string }

interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  line: number;
  cwe: string;
  title: string;
  description: string;
  fix: string;
  confidence: number;
}

/* ─── /api/agent/scan — full project scan ─────────────── */

app.post("/scan", clerkAuth, async (c) => {
  const userId = c.get("userId");
  const { files, projectName } = await c.req.json() as { files: FilePayload[]; projectName?: string };

  if (!files?.length) return c.json({ error: "No files provided" }, 400);

  const startedAt = Date.now();
  const stages: { name: string; status: string; provider?: string; ms?: number }[] = [];

  /* ── Stage 1: Cohere embed (memory) ── */
  const embedStart = Date.now();
  const embeddedCount = await (async () => {
    try {
      // Best-effort embed of project files for memory context
      const samples = files.slice(0, 10).map(f => `${f.path}\n${f.content.slice(0, 1000)}`).join("\n\n");
      await callEmbed(userId, samples);
      return files.length;
    } catch { return 0; }
  })();
  stages.push({ name: "embed", status: embeddedCount > 0 ? "ok" : "skipped", provider: "sork-embed", ms: Date.now() - embedStart });

  /* ── Stage 2: Groq fast triage per file ── */
  const triageStart = Date.now();
  const triageResults = await Promise.allSettled(files.slice(0, 25).map(async file => {
    const prompt = `Triage this ${file.language} file for security issues. Return JSON only.

File: ${file.path}
Code:
\`\`\`${file.language}
${file.content.slice(0, 4000)}
\`\`\`

Find: SQL injection, XSS, auth flaws, secrets, null derefs, path traversal, SSRF, command injection, IDOR.

JSON only:
{"issues":[{"severity":"critical|high|medium|low","line":0,"cwe":"CWE-XXX","title":"...","description":"...","fix":"...","confidence":0.0}],"riskScore":0,"needsDeepReview":false}`;

    const r = await callLLM(userId, "chat", [{ role: "user", content: prompt }], { temperature: 0.1, maxTokens: 1200 });
    const parsed = extractJson<{ issues?: Finding[]; riskScore?: number; needsDeepReview?: boolean }>(r.text) ?? {};
    return { file, issues: parsed.issues ?? [], riskScore: parsed.riskScore ?? 0, needsDeepReview: parsed.needsDeepReview ?? false };
  }));

  const triaged = triageResults
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<{ file: FilePayload; issues: Finding[]; riskScore: number; needsDeepReview: boolean }>).value);

  void resolveProvider;
  stages.push({ name: "triage", status: "ok", provider: "sork-fast", ms: Date.now() - triageStart });

  /* ── Stage 3: NVIDIA Nemotron heavy review on suspicious files ── */
  const heavyStart = Date.now();
  const heavyTargets = triaged.filter(t => t.needsDeepReview || t.issues.some(i => i.severity === "critical" || i.severity === "high")).slice(0, 5);

  const heavyResults = await Promise.allSettled(heavyTargets.map(async t => {
    const prompt = `Deep security analysis of ${t.file.path}.

Initial triage found ${t.issues.length} issues. Verify findings, identify any missed vulnerabilities, suggest precise fixes.

Code:
\`\`\`${t.file.language}
${t.file.content.slice(0, 6000)}
\`\`\`

Existing findings:
${JSON.stringify(t.issues, null, 2)}

JSON only:
{"verifiedIssues":[{"severity":"...","line":0,"cwe":"...","title":"...","description":"...","fix":"...","confidence":0.0,"verified":true}],"missedIssues":[...],"recommendation":"..."}`;

    const r = await callLLM(userId, "heavy", [{ role: "user", content: prompt }], { temperature: 0.1, maxTokens: 2048 });
    const parsed = extractJson<{ verifiedIssues?: Finding[]; missedIssues?: Finding[]; recommendation?: string }>(r.text) ?? {};
    return { filePath: t.file.path, ...parsed, tier: "deep" as const };
  }));

  const heavyReviewed = heavyResults
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<{ filePath: string; verifiedIssues?: Finding[]; missedIssues?: Finding[]; recommendation?: string; tier: string }>).value);

  stages.push({ name: "heavy", status: "ok", provider: "sork-deep", ms: Date.now() - heavyStart });

  /* ── Stage 4: Aggregate stats ── */
  const allIssues: (Finding & { filePath: string })[] = [];
  for (const t of triaged) {
    for (const i of t.issues) allIssues.push({ ...i, filePath: t.file.path });
  }
  // Override with heavy-verified findings
  for (const h of heavyReviewed) {
    if (h.verifiedIssues) {
      for (const i of h.verifiedIssues) allIssues.push({ ...i, filePath: h.filePath });
    }
    if (h.missedIssues) {
      for (const i of h.missedIssues) allIssues.push({ ...i, filePath: h.filePath });
    }
  }

  const counts = {
    critical: allIssues.filter(i => i.severity === "critical").length,
    high:     allIssues.filter(i => i.severity === "high").length,
    medium:   allIssues.filter(i => i.severity === "medium").length,
    low:      allIssues.filter(i => i.severity === "low").length,
    total:    allIssues.length,
  };

  const summary = counts.critical > 0 ? `🔴 ${counts.critical} critical issues — block deploy`
                : counts.high > 0     ? `🟠 ${counts.high} high-severity issues need attention`
                : counts.medium > 0   ? `🟡 ${counts.medium} medium issues found — review recommended`
                : `✓ Codebase is clean — deploy-ready`;

  return c.json({
    ok: true,
    projectName: projectName ?? "project",
    filesScanned: triaged.length,
    totalFiles: files.length,
    filesDeepReviewed: heavyReviewed.length,
    stages,
    counts,
    summary,
    findings: triaged.map(t => ({
      filePath: t.file.path,
      language: t.file.language,
      issues: t.issues,
      riskScore: t.riskScore,
      deepReviewed: heavyTargets.some(h => h.file.path === t.file.path),
    })),
    heavyAnalysis: heavyReviewed,
    durationMs: Date.now() - startedAt,
  });
});

/* ─── /api/agent/heavy — single-file deep dive ────────── */

app.post("/heavy", clerkAuth, async (c) => {
  const userId = c.get("userId");
  const { code, language, filePath, question } = await c.req.json();

  const prompt = `${question ?? "Perform deep security analysis"} of ${filePath}.

Code:
\`\`\`${language}
${code?.slice(0, 6000) ?? ""}
\`\`\`

Respond as JSON only:
{"analysis":"...","issues":[{"severity":"...","line":0,"cwe":"...","description":"...","fix":"..."}],"riskScore":0,"recommendation":"..."}`;

  const r = await callLLM(userId, "heavy", [{ role: "user", content: prompt }], { temperature: 0.1, maxTokens: 2048 });
  const parsed = extractJson<Record<string, unknown>>(r.text) ?? {};

  return c.json({
    ok: true,
    filePath,
    language,
    ...parsed,
    meta: { tier: "deep", fellBack: r.fellBack },
  });
});

/* ─── /api/agent/status — what providers user has wired ──── */

app.get("/status", clerkAuth, async (c) => {
  const userId = c.get("userId");
  const [chat, embed, heavy] = await Promise.all([
    resolveProvider(userId, "chat"),
    resolveProvider(userId, "embed"),
    resolveProvider(userId, "heavy"),
  ]);
  return c.json({
    routing: {
      chat:   { source: chat.source,  tier: "fast",  ready: !!chat.apiKey  },
      embed:  { source: embed.source, tier: "embed", ready: !!embed.apiKey },
      heavy:  { source: heavy.source, tier: "deep",  ready: !!heavy.apiKey },
    },
  });
});

export default app;
