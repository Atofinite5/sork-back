import { groqChat } from "../lib/providers/groq.js";
import type { TriageResult } from "./triage.js";

export interface FixChange {
  issue_id: string;
  issue_title: string;
  original: string;
  patched: string;
  explanation: string;
}

export interface FixResult {
  fixedCode: string;
  changes: FixChange[];
  explanation: string;
  patchApplied: boolean;
}

const FIX_SYSTEM = `You are SORK Fix — a principal security engineer who writes surgical, minimal security patches.

## Your job
Given vulnerable code and a triage report, produce the smallest possible patch that eliminates ALL reported vulnerabilities without changing any business logic or behavior.

## Principles
- Minimal diff: change ONLY what is needed to fix the vulnerability
- No refactoring: preserve variable names, structure, style
- No new dependencies unless strictly required
- Use established patterns: parameterized queries, input validation, crypto best practices
- Every change must be traceable to a specific issue ID

## Output format
Return ONLY valid JSON — no markdown fences:
{
  "patchApplied": true|false,
  "explanation": "<2-3 sentence summary of what was patched and how>",
  "fixedCode": "<complete fixed file content>",
  "changes": [
    {
      "issue_id": "SORK-001",
      "issue_title": "<title from triage>",
      "original": "<original vulnerable snippet>",
      "patched": "<replacement secure snippet>",
      "explanation": "<why this change fixes the issue>"
    }
  ]
}

If no fix is needed, return patchApplied: false and fixedCode equal to original.`;

export async function fixAgent(
  code: string,
  triage: TriageResult,
  model = "llama-3.3-70b-versatile"
): Promise<FixResult> {
  if (!triage.shouldFix || triage.issues.length === 0) {
    return {
      fixedCode: code,
      changes: [],
      explanation: "No fixes required — code is clean.",
      patchApplied: false,
    };
  }

  const issueBlock = triage.issues
    .filter((i) => i.severity === "critical" || i.severity === "high" || i.severity === "medium")
    .map((i) => `- [${i.id}] ${i.title} (${i.severity})\n  ${i.description}\n  Fix hint: ${i.fix_hint ?? "apply secure coding pattern"}`)
    .join("\n");

  const response = await groqChat(
    [
      { role: "system", content: FIX_SYSTEM },
      {
        role: "user",
        content: `## Issues to fix\n${issueBlock}\n\n## Original code\n\`\`\`\n${code}\n\`\`\``,
      },
    ],
    model,
    0.05,
    8192
  );

  try {
    const clean = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(clean) as FixResult;
  } catch {
    return {
      fixedCode: code,
      changes: [],
      explanation: response.slice(0, 200),
      patchApplied: false,
    };
  }
}
