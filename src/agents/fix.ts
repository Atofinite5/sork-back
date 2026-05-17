import { groqChat } from "../lib/providers/groq.js";
import type { TriageResult } from "./triage.js";

export interface FixResult {
  fixedCode: string;
  changes: Array<{ issue: string; change: string }>;
  explanation: string;
}

export async function fixAgent(code: string, triage: TriageResult): Promise<FixResult> {
  if (!triage.shouldFix || triage.issues.length === 0) {
    return { fixedCode: code, changes: [], explanation: "No fixes required." };
  }

  const issueList = triage.issues.map((i) => `- ${i.title}: ${i.description}`).join("\n");

  const response = await groqChat([
    {
      role: "system",
      content: `You are the SORK Fix Agent — a senior security engineer who writes safe, minimal patches. You receive vulnerable code and a triage report. Return a JSON object:
{
  "fixedCode": string,
  "changes": [{"issue": string, "change": string}],
  "explanation": string
}
Only return valid JSON, no markdown. Preserve the original code structure. Only fix the security issues, nothing else.`,
    },
    {
      role: "user",
      content: `Fix these security issues:\n${issueList}\n\nOriginal code:\n\`\`\`\n${code}\n\`\`\``,
    },
  ], "llama-3.3-70b-versatile", 0.1);

  try {
    return JSON.parse(response) as FixResult;
  } catch {
    return { fixedCode: code, changes: [], explanation: response };
  }
}
