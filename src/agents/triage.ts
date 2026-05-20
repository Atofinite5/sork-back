import { groqChat } from "../lib/providers/groq.js";
import { searchMemory } from "./memory.js";
import { extractJson } from "../lib/parseJson.js";

export interface TriageIssue {
  id: string;
  title: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: "injection" | "auth" | "secrets" | "xss" | "ssrf" | "crypto" | "logic" | "dependency" | "config" | "other";
  file?: string;
  line?: number;
  snippet?: string;
  cwe?: string;
  fix_hint?: string;
}

export interface TriageResult {
  severity: "critical" | "high" | "medium" | "low" | "info";
  issues: TriageIssue[];
  summary: string;
  shouldFix: boolean;
  confidence: number;
  language?: string;
  linesScanned?: number;
}

const TRIAGE_SYSTEM = `You are SORK Triage — a principal security engineer with 15 years of experience auditing production codebases.

## Your job
Perform an exhaustive, line-by-line security triage of the provided code. Be precise, not paranoid. Only flag real vulnerabilities, not theoretical concerns.

## Vulnerability categories (scan all)
- injection: SQL, NoSQL, command, LDAP, XPath injection
- auth: broken authentication, missing authz checks, IDOR, privilege escalation, JWT issues
- secrets: hardcoded API keys, passwords, tokens, private keys in source
- xss: reflected, stored, DOM-based XSS; dangerouslySetInnerHTML
- ssrf: user-controlled URLs fetched server-side
- crypto: weak algorithms (MD5, SHA1, DES), hardcoded IVs, insecure random
- logic: race conditions, off-by-ones, unchecked return values, TOCTOU
- dependency: known-vulnerable package versions, insecure imports
- config: debug mode in prod, overly permissive CORS, missing security headers
- other: path traversal, insecure deserialization, prototype pollution, ReDoS

## Output format
Return ONLY valid JSON — no markdown fences, no explanation outside the JSON:
{
  "severity": "critical|high|medium|low|info",
  "confidence": 0-100,
  "language": "typescript|javascript|python|...",
  "linesScanned": <number>,
  "summary": "<2-3 sentence executive summary of what you found>",
  "shouldFix": true|false,
  "issues": [
    {
      "id": "SORK-001",
      "title": "<short, precise title>",
      "description": "<what is vulnerable and why it is exploitable>",
      "severity": "critical|high|medium|low|info",
      "category": "<category from above>",
      "file": "<filename or null>",
      "line": <line number or null>,
      "snippet": "<the vulnerable code snippet, max 80 chars>",
      "cwe": "CWE-89",
      "fix_hint": "<one-line actionable fix hint>"
    }
  ]
}

## Rules
- severity = WORST issue found overall
- shouldFix = true if ANY critical/high issue exists
- confidence = how certain you are (100 = provably exploitable, 70 = likely vulnerable, 50 = needs context)
- If code is clean, return issues: [] and severity: "info"
- Never flag issues you are not at least 70% confident about`;

export async function triageAgent(
  userId: string,
  code: string,
  context?: string,
  model = "llama-3.3-70b-versatile"
): Promise<TriageResult> {
  const relevantMemory = await searchMemory(userId, code.slice(0, 400), 3);
  const memoryContext = relevantMemory.length > 0
    ? `\n\n## Prior context from this codebase\n${relevantMemory.map((m) => `- ${m.content}`).join("\n")}`
    : "";

  const lines = code.split("\n").length;
  const userPrompt = [
    context ? `## Context\n${context}` : "",
    memoryContext,
    `## Code to audit (${lines} lines)\n\`\`\`\n${code}\n\`\`\``,
  ].filter(Boolean).join("\n\n");

  const response = await groqChat(
    [
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    model,
    0.1,
    4096
  );

  const parsed = extractJson<TriageResult>(response);
  if (parsed) return { ...parsed, linesScanned: lines };

  return {
    severity: "info",
    issues: [],
    summary: "Could not parse triage response.",
    shouldFix: false,
    confidence: 0,
    linesScanned: lines,
  };
}
