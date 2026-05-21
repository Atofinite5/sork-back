import { Hono } from "hono";
import { clerkAuth, licenseAuth } from "../middleware/auth.js";
import type { HonoEnv } from "../types.js";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = new Hono<HonoEnv>();

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  try { return JSON.parse(fence ? fence[1] : text); } catch { return {}; }
}

async function callGroq(prompt: string, maxTokens = 2048) {
  const c = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: maxTokens,
  });
  return extractJson(c.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
}

/* ── SAST ── Static Application Security Testing ─────── */

app.post("/sast", clerkAuth, async (c) => {
  const { code, language, filePath } = await c.req.json();

  const result = await callGroq(`Run SAST analysis on this ${language} code (${filePath}).
Find: SQL injection, XSS, broken auth, sensitive data exposure, security misconfiguration,
insecure deserialization, SSRF, path traversal, command injection, IDOR.

Code:
\`\`\`${language}
${(code ?? "").slice(0, 6000)}
\`\`\`

Respond JSON only:
{
  "findings": [{ "type": "...", "severity": "critical|high|medium|low", "line": 0, "cwe": "CWE-XXX", "description": "...", "recommendation": "...", "confidence": 0.0 }],
  "riskScore": 0,
  "summary": "...",
  "passedChecks": 0,
  "totalChecks": 0
}`);

  return c.json({ ok: true, type: "sast", filePath, language, ...result });
});

/* ── Secrets Scanning ─────────────────────────────────── */

app.post("/secrets", clerkAuth, async (c) => {
  const { code, filePath } = await c.req.json();

  const result = await callGroq(`Scan for hardcoded secrets in ${filePath}.
Find: API keys, tokens, passwords, private keys, connection strings, OAuth secrets,
AWS/GCP/Azure credentials, JWT secrets, encryption keys, webhook secrets.

Content:
${(code ?? "").slice(0, 5000)}

Respond JSON only:
{
  "secrets": [{ "type": "...", "line": 0, "masked": "***...", "severity": "critical|high", "entropy": 0.0, "recommendation": "..." }],
  "clean": true,
  "riskLevel": "none|low|high|critical"
}`, 1024);

  return c.json({ ok: true, type: "secrets", filePath, ...result });
});

/* ── Dependency Vulnerabilities ──────────────────────── */

app.post("/dependencies", clerkAuth, async (c) => {
  const { manifest, ecosystem, filePath } = await c.req.json();
  // ecosystem: npm | pip | maven | gradle | cargo | gem | go

  const result = await callGroq(`Analyze ${ecosystem} dependencies in ${filePath ?? "manifest"} for vulnerabilities.
Check: known CVEs, outdated packages, known malicious packages, license risks, deprecated packages.

Manifest:
${(manifest ?? "").slice(0, 5000)}

Respond JSON only:
{
  "vulnerabilities": [{ "package": "...", "version": "...", "severity": "critical|high|medium|low", "cve": "...", "description": "...", "fixedIn": "...", "recommendation": "..." }],
  "outdated": [{ "package": "...", "current": "...", "latest": "...", "breakingChange": false }],
  "deprecated": ["..."],
  "riskScore": 0,
  "totalDependencies": 0
}`);

  return c.json({ ok: true, type: "dependencies", ecosystem, ...result });
});

/* ── IaC Scanning ─────────────────────────────────────── */

app.post("/iac", clerkAuth, async (c) => {
  const { code, fileType, filePath } = await c.req.json();
  // fileType: dockerfile | kubernetes | terraform | helm | compose | ansible

  const result = await callGroq(`Scan ${fileType} IaC file (${filePath}) for security misconfigurations.
Find: exposed ports, privileged containers, missing resource limits, insecure defaults,
hardcoded secrets, overpermissioned roles, missing network policies, insecure base images.

Content:
${(code ?? "").slice(0, 5000)}

Respond JSON only:
{
  "findings": [{ "rule": "...", "severity": "critical|high|medium|low|info", "line": 0, "description": "...", "fix": "...", "reference": "..." }],
  "riskScore": 0,
  "passedChecks": 0,
  "failedChecks": 0,
  "summary": "..."
}`);

  return c.json({ ok: true, type: "iac", fileType, filePath, ...result });
});

/* ── License Compliance ──────────────────────────────── */

app.post("/licenses", clerkAuth, async (c) => {
  const { manifest, ecosystem } = await c.req.json();

  const result = await callGroq(`Analyze license compliance for ${ecosystem} dependencies.

Manifest:
${(manifest ?? "").slice(0, 4000)}

Identify licenses, flag GPL/AGPL copyleft risks, LGPL implications.
Respond JSON only:
{
  "licenses": [{ "package": "...", "license": "...", "risk": "none|low|medium|high", "commercial_use": true, "copyleft": false }],
  "riskySpdxIds": ["..."],
  "summary": "...",
  "action_required": false
}`, 1500);

  return c.json({ ok: true, type: "licenses", ecosystem, ...result });
});

/* ── Code Quality / Smell Analysis ───────────────────── */

app.post("/quality", clerkAuth, async (c) => {
  const { code, language, filePath } = await c.req.json();

  const result = await callGroq(`Analyze code quality and smells in this ${language} file (${filePath}).
Check: cyclomatic complexity, duplicate code, long functions, god classes, deep nesting,
magic numbers, missing error handling, dead code, poor naming.

Code:
\`\`\`${language}
${(code ?? "").slice(0, 6000)}
\`\`\`

Respond JSON only:
{
  "smells": [{ "type": "...", "severity": "high|medium|low", "line": 0, "description": "...", "suggestion": "..." }],
  "metrics": { "linesOfCode": 0, "complexity": 0, "maintainabilityIndex": 0, "technicalDebt": "Xh" },
  "qualityScore": 0,
  "summary": "..."
}`);

  return c.json({ ok: true, type: "quality", filePath, language, ...result });
});

export default app;
