import { groqChat } from "../lib/providers/groq.js";
import type { TriageResult } from "./triage.js";
import type { FixResult } from "./fix.js";

export interface VerifyResult {
  passed: boolean;
  residualIssues: Array<{ title: string; description: string }>;
  confidence: number; // 0-100
  recommendation: "approve" | "rework" | "escalate";
  notes: string;
}

export async function verifyAgent(
  originalCode: string,
  fixResult: FixResult,
  triage: TriageResult
): Promise<VerifyResult> {
  const response = await groqChat([
    {
      role: "system",
      content: `You are the SORK Verify Agent — a principal security reviewer. Compare the original vulnerable code with the fixed version and verify that all issues were resolved correctly without introducing new vulnerabilities. Return JSON:
{
  "passed": boolean,
  "residualIssues": [{"title": string, "description": string}],
  "confidence": number,
  "recommendation": "approve|rework|escalate",
  "notes": string
}
Only return valid JSON, no markdown.`,
    },
    {
      role: "user",
      content: `Original issues:\n${triage.issues.map((i) => `- ${i.title}`).join("\n")}\n\nApplied changes:\n${fixResult.changes.map((c) => `- ${c.issue}: ${c.change}`).join("\n")}\n\nOriginal:\n\`\`\`\n${originalCode}\n\`\`\`\n\nFixed:\n\`\`\`\n${fixResult.fixedCode}\n\`\`\``,
    },
  ]);

  try {
    return JSON.parse(response) as VerifyResult;
  } catch {
    return {
      passed: false,
      residualIssues: [],
      confidence: 50,
      recommendation: "rework",
      notes: response,
    };
  }
}
