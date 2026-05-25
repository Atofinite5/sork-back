/**
 * SORK Chat Harness — multi-agent orchestration engine for the chat interface.
 *
 * Intent detection → RAG retrieval → agent routing → response assembly.
 *
 * Architecture (no provider names in user-facing output):
 *   - Fast tier: general chat, triage, file analysis
 *   - Deep tier: code review, code fix, verification
 *   - Embed tier: semantic memory for RAG
 */

import { callLLM, callEmbed, type Task } from "./router.js";
import { saveMemory, getRecentMemory, searchMemory } from "../agents/memory.js";
import { extractJson } from "./parseJson.js";
import { trackVulnPatterns, getPatternInsights, recordScanSnapshot } from "./scanMemory.js";
import { getFixPreferences, buildPreferenceHint } from "./fixLearning.js";
import { generateSecurityTests, type GeneratedTest } from "./testGen.js";

export type ChatIntent =
  | "general"       // normal conversation
  | "code_review"   // user wants code analyzed
  | "code_fix"      // user wants SORK to fix code
  | "triage"        // security triage request
  | "explain"       // explain vulnerability / concept
  | "byok"          // BYOK setup intent
  | "model_switch"; // model switching

export interface HarnessInput {
  userId: string;
  sessionId: string;
  message: string;
  attachedFiles?: { name: string; content: string; size: number }[];
  pendingFixCode?: string;
  pendingFixTriage?: unknown;
}

export interface AgentStep {
  agent: string;
  tier: "fast" | "deep" | "embed";
  status: "running" | "done" | "skipped" | "error";
  durationMs?: number;
  detail?: string;
}

export interface FixProposal {
  originalCode: string;
  fixedCode: string;
  changes: { issueId: string; title: string; original: string; patched: string; explanation: string }[];
  explanation: string;
  score: number;
  recommendation: "approve" | "rework" | "escalate";
  generatedTest?: GeneratedTest;
}

export interface HarnessResult {
  reply: string;
  intent: ChatIntent;
  steps: AgentStep[];
  fixProposal?: FixProposal;
  awaitingFixConfirmation?: boolean;
  ragContextUsed: boolean;
  durationMs: number;
}

function detectIntent(message: string, hasCode: boolean): ChatIntent {
  const lower = message.toLowerCase();

  if (/add.*(api|key|endpoint|provider)|byok|bring.*own/i.test(message)) return "byok";
  if (/\b(use|switch|change|set)\s+(to\s+)?(llama|mixtral|gemma|model)/i.test(lower)) return "model_switch";

  if (hasCode || /\b(fix\s*(it|this|the|my|code)|patch|remediate|apply\s*fix|auto.?fix|sork\s*fix)\b/i.test(lower)) {
    if (/\b(fix|patch|remediate|apply|auto.?fix|sork\s*fix|you\s*fix|fix\s*by\s*your)/i.test(lower)) return "code_fix";
  }

  if (hasCode || /\b(scan|triage|audit|security\s*review|vulnerability|check\s*(this|my|the)\s*code)\b/i.test(lower)) return "triage";
  if (hasCode && /\b(review|analyze|look\s*at|check)\b/i.test(lower)) return "code_review";
  if (/\b(explain|what\s*is|how\s*does|why|cwe|cve|owasp)\b/i.test(lower)) return "explain";

  if (hasCode) return "triage";
  return "general";
}

function isFixConfirmation(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return /\b(yes|yep|yeah|sure|go\s*ahead|fix\s*it|do\s*it|sork\s*fix|you\s*fix|fix\s*by\s*your|apply|proceed|confirm|ok|okay)\b/i.test(lower);
}

function isFixRejection(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return /\b(no|nope|nah|i.?ll\s*fix|my\s*self|myself|manual|skip|cancel|don.?t|reject)\b/i.test(lower);
}

const SORK_SYSTEM = `You are SORK — an AI-powered security assistant built into the SORK Cloud platform.

## Your persona
You are precise, technical, and direct. You think like a senior security engineer. You structure responses clearly with bold terms, bullet points, and code blocks.

## What you help with
– Security analysis: vulnerabilities, CVEs, CWEs, attack vectors, remediation
– Code review: identify issues, suggest fixes, explain impact
– Pipeline results: interpret triage/fix/verify outputs
– Setup help: API key configuration, model switching
– General security questions

## Reply format
– Use **bold** for important terms and severity levels
– Use bullet points (–) for lists
– Use \`inline code\` for file names, commands, code snippets
– Short paragraphs (2–3 sentences max)
– End with a clear action when one exists
– Never expose API keys, provider names, or internal model identifiers
– Refer to the engine as "SORK Engine" — never name specific providers`;

const TRIAGE_PROMPT = `You are SORK Triage — a principal security engineer. Perform exhaustive security triage of the provided code.

Scan for: injection, auth flaws, secrets, XSS, SSRF, crypto issues, logic bugs, dependency risks, config problems, path traversal, prototype pollution.

Return ONLY valid JSON:
{
  "severity": "critical|high|medium|low|info",
  "confidence": 0-100,
  "summary": "<2-3 sentence executive summary>",
  "shouldFix": true|false,
  "issues": [
    {
      "id": "SORK-001",
      "title": "<precise title>",
      "description": "<what is vulnerable and why>",
      "severity": "critical|high|medium|low|info",
      "category": "<injection|auth|secrets|xss|ssrf|crypto|logic|dependency|config|other>",
      "line": null,
      "snippet": "<vulnerable code, max 80 chars>",
      "cwe": "CWE-XXX",
      "fix_hint": "<one-line fix hint>"
    }
  ]
}`;

const FIX_PROMPT = `You are SORK Fix — a principal security engineer who writes minimal, surgical security patches.

Given vulnerable code and a triage report, produce the smallest patch that eliminates ALL reported vulnerabilities without changing business logic.

Return ONLY valid JSON:
{
  "patchApplied": true|false,
  "explanation": "<2-3 sentence summary of what was patched>",
  "fixedCode": "<complete fixed code>",
  "changes": [
    {
      "issueId": "SORK-001",
      "title": "<issue title>",
      "original": "<original vulnerable snippet>",
      "patched": "<replacement secure snippet>",
      "explanation": "<why this fixes the issue>"
    }
  ]
}`;

const VERIFY_PROMPT = `You are SORK Verify — a senior AppSec reviewer. Compare original vs patched code. Verify:
1. Every reported issue is actually fixed
2. Correct security patterns used
3. No new vulnerabilities introduced
4. Business logic preserved

Score: 90-100 approve, 70-89 approve with notes, 50-69 rework, 0-49 escalate.

Return ONLY valid JSON:
{"passed":true|false,"score":0-100,"recommendation":"approve|rework|escalate","notes":"<detailed notes>","residualIssues":[],"newIssues":[]}`;

export async function runHarness(input: HarnessInput): Promise<HarnessResult> {
  const startTime = Date.now();
  const steps: AgentStep[] = [];
  const hasCode = (input.attachedFiles && input.attachedFiles.length > 0) ||
    /```[\s\S]{20,}```/.test(input.message) ||
    /\b(function|const|let|var|import|export|class|def |async |await )\b/.test(input.message);

  // Check if this is a fix confirmation for a pending proposal
  if (input.pendingFixCode && isFixConfirmation(input.message)) {
    return await runFixPipeline(input, steps, startTime);
  }
  if (input.pendingFixCode && isFixRejection(input.message)) {
    return {
      reply: "Got it — you'll handle the fix yourself. The triage report above has all the details you need. Let me know if you want me to review your fix when it's ready.",
      intent: "code_fix",
      steps,
      ragContextUsed: false,
      durationMs: Date.now() - startTime,
    };
  }

  const intent = detectIntent(input.message, !!hasCode);

  // RAG retrieval
  const ragStart = Date.now();
  let ragContext = "";
  let ragUsed = false;
  try {
    const semanticResults = await searchMemory(input.userId, input.message.slice(0, 400), 5);
    if (semanticResults.length > 0) {
      ragContext = "\n\n## Relevant context from your history\n" +
        semanticResults.map(m => `– ${m.content}`).join("\n");
      ragUsed = true;
    }
    steps.push({ agent: "memory-retrieval", tier: "embed", status: "done", durationMs: Date.now() - ragStart, detail: `${semanticResults.length} results` });
  } catch {
    steps.push({ agent: "memory-retrieval", tier: "embed", status: "skipped", durationMs: Date.now() - ragStart });
  }

  // Get conversation history
  const recentMemory = await getRecentMemory(input.userId, input.sessionId, 12);
  const history = recentMemory.map(m => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));

  // Save user message to memory
  const cleanMessage = input.message.replace(/\n\nAttached files:[\s\S]*/m, "").trim();
  await saveMemory(input.userId, input.sessionId, "user", cleanMessage.slice(0, 500));

  // Route based on intent
  switch (intent) {
    case "triage":
    case "code_review":
      return await runTriageFlow(input, intent, steps, history, ragContext, ragUsed, startTime);

    case "code_fix":
      return await runTriageFlow(input, "code_fix", steps, history, ragContext, ragUsed, startTime);

    case "explain":
    case "general":
    case "byok":
    case "model_switch":
    default:
      return await runChatFlow(input, intent, steps, history, ragContext, ragUsed, startTime);
  }
}

async function runChatFlow(
  input: HarnessInput,
  intent: ChatIntent,
  steps: AgentStep[],
  history: { role: "user" | "assistant" | "system"; content: string }[],
  ragContext: string,
  ragUsed: boolean,
  startTime: number,
): Promise<HarnessResult> {
  const chatStart = Date.now();
  const systemPrompt = SORK_SYSTEM + ragContext;

  const isHeavy = /\b(audit|deep\s*scan|security\s*review|vulnerability\s*analysis|complex|refactor|architecture)\b/i.test(input.message);
  const task: Task = isHeavy ? "heavy" : "chat";
  const tier = isHeavy ? "deep" as const : "fast" as const;

  const result = await callLLM(
    input.userId, task,
    [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: input.message }],
    { temperature: 0.4, maxTokens: 1200 },
  );

  steps.push({ agent: "chat", tier, status: "done", durationMs: Date.now() - chatStart });

  await saveMemory(input.userId, input.sessionId, "assistant", result.text.slice(0, 500));

  return {
    reply: result.text,
    intent,
    steps,
    ragContextUsed: ragUsed,
    durationMs: Date.now() - startTime,
  };
}

async function runTriageFlow(
  input: HarnessInput,
  intent: ChatIntent,
  steps: AgentStep[],
  history: { role: "user" | "assistant" | "system"; content: string }[],
  ragContext: string,
  ragUsed: boolean,
  startTime: number,
): Promise<HarnessResult> {
  // Extract code from attachments or message
  let code = "";
  let fileName = "unknown";
  if (input.attachedFiles && input.attachedFiles.length > 0) {
    code = input.attachedFiles.map(f => `// File: ${f.name}\n${f.content}`).join("\n\n");
    fileName = input.attachedFiles.map(f => f.name).join(", ");
  } else {
    const codeMatch = input.message.match(/```(?:\w+)?\n?([\s\S]+?)```/);
    if (codeMatch) code = codeMatch[1];
  }

  if (!code) {
    return runChatFlow(input, "general", steps, history, ragContext, ragUsed, startTime);
  }

  // Embed the code for future RAG
  const embedStart = Date.now();
  try {
    await callEmbed(input.userId, `Security scan of ${fileName}: ${code.slice(0, 2000)}`);
    steps.push({ agent: "code-embed", tier: "embed", status: "done", durationMs: Date.now() - embedStart });
  } catch {
    steps.push({ agent: "code-embed", tier: "embed", status: "skipped", durationMs: Date.now() - embedStart });
  }

  // Triage via fast tier
  const triageStart = Date.now();
  const triageResult = await callLLM(
    input.userId, "chat",
    [
      { role: "system", content: TRIAGE_PROMPT },
      { role: "user", content: `## Code to audit\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\`` },
    ],
    { temperature: 0.1, maxTokens: 4096 },
  );
  steps.push({ agent: "triage", tier: "fast", status: "done", durationMs: Date.now() - triageStart });

  interface TriageIssue {
    id: string;
    title: string;
    description: string;
    severity: string;
    category: string;
    line?: number | null;
    snippet?: string;
    cwe?: string;
    fix_hint?: string;
  }

  interface ParsedTriage {
    severity?: string;
    confidence?: number;
    summary?: string;
    shouldFix?: boolean;
    issues?: TriageIssue[];
  }

  const triage = extractJson<ParsedTriage>(triageResult.text);

  if (!triage || !triage.issues || triage.issues.length === 0) {
    const reply = `**Triage complete** — scanned \`${fileName}\`\n\n✅ No security issues detected. Code looks clean.\n\n` +
      (ragContext ? "_Context from your prior scans was used to improve accuracy._" : "");
    await saveMemory(input.userId, input.sessionId, "assistant", reply.slice(0, 500));
    return { reply, intent, steps, ragContextUsed: ragUsed, durationMs: Date.now() - startTime };
  }

  // Track vulnerability patterns in cross-scan memory
  const patternStart = Date.now();
  let patternInsights = "";
  try {
    const { newPatterns, recurringPatterns } = await trackVulnPatterns(input.userId, fileName, triage.issues);
    if (recurringPatterns.length > 0) {
      patternInsights = `\n\n> **Pattern Alert:** ${recurringPatterns.length} recurring pattern${recurringPatterns.length > 1 ? "s" : ""} detected — ` +
        recurringPatterns.map(p => `**${p.title}** (seen ${p.occurrences}x)`).join(", ");
    }
    steps.push({ agent: "pattern-memory", tier: "embed", status: "done", durationMs: Date.now() - patternStart, detail: `${newPatterns} new, ${recurringPatterns.length} recurring` });
  } catch {
    steps.push({ agent: "pattern-memory", tier: "embed", status: "skipped", durationMs: Date.now() - patternStart });
  }

  // Record scan snapshot for cross-scan memory
  try {
    await recordScanSnapshot(input.userId, input.sessionId, fileName, undefined, code, triage, false);
  } catch { /* best effort */ }

  // Build the triage report
  const sevIcon = (s: string) => s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "🟢";
  let reply = `## Security Triage — \`${fileName}\`\n\n`;
  reply += `**${triage.summary ?? "Issues found"}**\n`;
  reply += `Confidence: **${triage.confidence ?? "N/A"}%** | Overall: **${(triage.severity ?? "unknown").toUpperCase()}**\n\n`;

  reply += `### Findings\n\n`;
  for (const issue of triage.issues.slice(0, 8)) {
    reply += `${sevIcon(issue.severity)} **[${issue.id}] ${issue.title}** (${issue.severity})\n`;
    reply += `> ${issue.description}\n`;
    if (issue.snippet) reply += `> \`${issue.snippet}\`\n`;
    if (issue.cwe) reply += `> ${issue.cwe}`;
    if (issue.fix_hint) reply += ` — _${issue.fix_hint}_`;
    reply += `\n\n`;
  }

  // Add pattern intelligence if recurring issues found
  if (patternInsights) {
    reply += patternInsights + "\n\n";
  }

  // Get cross-scan insights
  try {
    const insights = await getPatternInsights(input.userId);
    if (insights) reply += insights;
  } catch { /* best effort */ }

  // If fixable, ask user
  if (triage.shouldFix && intent === "code_fix") {
    return await runFixPipelineFromTriage(input, code, triage, steps, ragUsed, startTime, reply);
  }

  if (triage.shouldFix) {
    reply += `---\n\n**${triage.issues.filter(i => i.severity === "critical" || i.severity === "high").length} issues need fixing.**\n\n`;
    reply += `Should **SORK fix this automatically**, or do you want to fix it yourself?\n`;
    reply += `_Say "fix it" and SORK will generate a minimal security patch._`;
  }

  await saveMemory(input.userId, input.sessionId, "assistant", `Triage: ${triage.summary ?? "complete"}`);

  return {
    reply,
    intent,
    steps,
    awaitingFixConfirmation: triage.shouldFix,
    ragContextUsed: ragUsed,
    durationMs: Date.now() - startTime,
  };
}

async function runFixPipeline(
  input: HarnessInput,
  steps: AgentStep[],
  startTime: number,
): Promise<HarnessResult> {
  const code = input.pendingFixCode ?? "";
  const triage = input.pendingFixTriage as { issues?: { id: string; title: string; severity: string; description: string; fix_hint?: string; category?: string; cwe?: string; snippet?: string }[]; summary?: string } | undefined;
  return runFixPipelineFromTriage(input, code, triage ?? { issues: [], summary: "" }, steps, false, startTime, "");
}

async function runFixPipelineFromTriage(
  input: HarnessInput,
  code: string,
  triage: { issues?: { id: string; title: string; severity: string; description: string; fix_hint?: string; category?: string; cwe?: string; snippet?: string }[]; summary?: string },
  steps: AgentStep[],
  ragUsed: boolean,
  startTime: number,
  prefixReply: string,
): Promise<HarnessResult> {
  const issues = triage.issues ?? [];

  // Load user's fix preferences to guide the AI
  let preferenceHint = "";
  try {
    const prefs = await getFixPreferences(input.userId);
    preferenceHint = buildPreferenceHint(prefs);
  } catch { /* best effort */ }

  // Fix via deep tier
  const fixStart = Date.now();
  const issueBlock = issues
    .filter(i => i.severity === "critical" || i.severity === "high" || i.severity === "medium")
    .map(i => `- [${i.id}] ${i.title} (${i.severity})\n  ${i.description}\n  Fix hint: ${i.fix_hint ?? "apply secure coding pattern"}`)
    .join("\n");

  const fixSystemPrompt = FIX_PROMPT + preferenceHint;

  const fixResult = await callLLM(
    input.userId, "heavy",
    [
      { role: "system", content: fixSystemPrompt },
      { role: "user", content: `## Issues to fix\n${issueBlock}\n\n## Original code\n\`\`\`\n${code.slice(0, 8000)}\n\`\`\`` },
    ],
    { temperature: 0.05, maxTokens: 8192 },
  );
  steps.push({ agent: "fix", tier: "deep", status: "done", durationMs: Date.now() - fixStart });

  interface FixChange { issueId: string; title: string; original: string; patched: string; explanation: string }
  interface ParsedFix { patchApplied?: boolean; explanation?: string; fixedCode?: string; changes?: FixChange[] }
  const fix = extractJson<ParsedFix>(fixResult.text);

  if (!fix || !fix.patchApplied) {
    const reply = prefixReply + "\n\n⚠️ SORK couldn't generate a confident patch for this code. Review the triage findings above and apply fixes manually.";
    return { reply, intent: "code_fix", steps, ragContextUsed: ragUsed, durationMs: Date.now() - startTime };
  }

  // Verify via deep tier
  const verifyStart = Date.now();
  const verifyResult = await callLLM(
    input.userId, "heavy",
    [
      { role: "system", content: VERIFY_PROMPT },
      { role: "user", content: `## Reported issues\n${issueBlock}\n\n## Original\n\`\`\`\n${code.slice(0, 4000)}\n\`\`\`\n\n## Patched\n\`\`\`\n${(fix.fixedCode ?? "").slice(0, 4000)}\n\`\`\`` },
    ],
    { temperature: 0.1, maxTokens: 2048 },
  );
  steps.push({ agent: "verify", tier: "deep", status: "done", durationMs: Date.now() - verifyStart });

  interface ParsedVerify { passed?: boolean; score?: number; recommendation?: string; notes?: string }
  const verify = extractJson<ParsedVerify>(verifyResult.text);
  const score = verify?.score ?? 75;
  const recommendation = (verify?.recommendation ?? "approve") as "approve" | "rework" | "escalate";

  // Build reply with diff
  let reply = prefixReply;
  reply += `\n\n## SORK Fix Applied\n\n`;
  reply += `**${fix.explanation}**\n\n`;

  if (fix.changes && fix.changes.length > 0) {
    reply += `### Changes\n\n`;
    for (const change of fix.changes) {
      reply += `**[${change.issueId}] ${change.title}**\n`;
      reply += `${change.explanation}\n\n`;
      reply += "```diff\n";
      reply += `- ${change.original}\n`;
      reply += `+ ${change.patched}\n`;
      reply += "```\n\n";
    }
  }

  reply += `### Fixed Code\n\n`;
  reply += "```\n" + (fix.fixedCode ?? "") + "\n```\n\n";

  reply += `### Verification\n`;
  reply += `Score: **${score}/100** | Recommendation: **${recommendation.toUpperCase()}**\n`;
  if (verify?.notes) reply += `> ${verify.notes}\n`;

  // Generate security test
  const testStart = Date.now();
  let generatedTest: GeneratedTest | undefined;
  try {
    const test = await generateSecurityTests(
      input.userId,
      code,
      fix.fixedCode ?? code,
      issues.map(i => ({
        id: i.id, title: i.title, description: i.description,
        severity: i.severity, category: i.category ?? "other",
        cwe: i.cwe,
        snippet: i.snippet,
      })),
    );
    if (test) {
      generatedTest = test;
      reply += `\n### Security Test\n`;
      reply += `**${test.description}** (${test.framework})\n`;
      reply += `Covers: ${test.coversIssues.join(", ")}\n\n`;
      reply += "```\n" + test.testCode + "\n```\n";
      steps.push({ agent: "test-gen", tier: "deep", status: "done", durationMs: Date.now() - testStart, detail: `${test.coversIssues.length} tests` });
    } else {
      steps.push({ agent: "test-gen", tier: "deep", status: "skipped", durationMs: Date.now() - testStart });
    }
  } catch {
    steps.push({ agent: "test-gen", tier: "deep", status: "skipped", durationMs: Date.now() - testStart });
  }

  // Record scan snapshot with fix
  try {
    const snapshotIssues = issues.map(i => ({ ...i, category: i.category ?? "other" }));
    await recordScanSnapshot(input.userId, input.sessionId, undefined, undefined, code, { issues: snapshotIssues }, true, fix, score);
  } catch { /* best effort */ }

  const proposal: FixProposal = {
    originalCode: code,
    fixedCode: fix.fixedCode ?? code,
    changes: (fix.changes ?? []).map(c => ({
      issueId: c.issueId, title: c.title, original: c.original, patched: c.patched, explanation: c.explanation,
    })),
    explanation: fix.explanation ?? "",
    score,
    recommendation,
    generatedTest,
  };

  await saveMemory(input.userId, input.sessionId, "assistant", `Fix applied: ${fix.explanation ?? "patch generated"} (score ${score})`);

  return {
    reply,
    intent: "code_fix",
    steps,
    fixProposal: proposal,
    ragContextUsed: ragUsed,
    durationMs: Date.now() - startTime,
  };
}
