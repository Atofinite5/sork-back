import { groqChat } from "../lib/providers/groq.js";
import type { TriageResult } from "./triage.js";
import type { FixResult } from "./fix.js";
import { extractJson } from "../lib/parseJson.js";

export interface VerifyResult {
  passed: boolean;
  residualIssues: Array<{ id: string; title: string; reason: string }>;
  newIssues: Array<{ title: string; description: string; severity: string }>;
  confidence: number;
  recommendation: "approve" | "rework" | "escalate";
  notes: string;
  score: number;
}

const VERIFY_SYSTEM = `You are SORK Verify — a senior AppSec reviewer doing final sign-off on a security patch.

## Your job
Compare the original vulnerable code against the patched version. Verify that:
1. Every reported issue is actually fixed (not just hidden or suppressed)
2. The fix uses the correct security pattern (not a superficial workaround)
3. No new vulnerabilities were introduced by the patch
4. Business logic is preserved

## Scoring
- score 90–100: Clean fix, approve
- score 70–89: Minor concerns, approve with notes
- score 50–69: Fix is incomplete or introduces new risk, rework
- score 0–49: Fix is wrong or makes things worse, escalate

## Output format
Return ONLY valid JSON — no markdown fences:
{
  "passed": true|false,
  "confidence": 0-100,
  "score": 0-100,
  "recommendation": "approve|rework|escalate",
  "notes": "<detailed reviewer notes — what was fixed well, what concerns remain>",
  "residualIssues": [
    { "id": "SORK-001", "title": "...", "reason": "why it was not fully fixed" }
  ],
  "newIssues": [
    { "title": "...", "description": "...", "severity": "critical|high|medium|low" }
  ]
}`;

export async function verifyAgent(
  originalCode: string,
  fixResult: FixResult,
  triage: TriageResult,
  model = "llama-3.3-70b-versatile"
): Promise<VerifyResult> {
  if (!fixResult.patchApplied) {
    return {
      passed: true,
      residualIssues: [],
      newIssues: [],
      confidence: 100,
      recommendation: "approve",
      notes: "No patch was applied — code was already clean.",
      score: 100,
    };
  }

  const issueList = triage.issues
    .map((i) => `[${i.id}] ${i.title} (${i.severity}) — ${i.description}`)
    .join("\n");

  const changeList = fixResult.changes
    .map((c) => `[${c.issue_id}] ${c.issue_title}: ${c.explanation}`)
    .join("\n");

  const response = await groqChat(
    [
      { role: "system", content: VERIFY_SYSTEM },
      {
        role: "user",
        content: [
          `## Reported issues\n${issueList}`,
          `## Changes applied\n${changeList}`,
          `## Original code\n\`\`\`\n${originalCode}\n\`\`\``,
          `## Patched code\n\`\`\`\n${fixResult.fixedCode}\n\`\`\``,
        ].join("\n\n"),
      },
    ],
    model,
    0.1,
    2048
  );

  const parsed = extractJson<VerifyResult>(response);
  if (parsed) return parsed;

  return { passed: false, residualIssues: [], newIssues: [], confidence: 50, recommendation: "rework", notes: "Could not parse verify response.", score: 50 };
}
