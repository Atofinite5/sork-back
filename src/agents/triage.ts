import { groqChat } from "../lib/providers/groq.js";
import { searchMemory } from "./memory.js";

export interface TriageResult {
  severity: "critical" | "high" | "medium" | "low" | "info";
  issues: Array<{ title: string; description: string; file?: string; line?: number }>;
  summary: string;
  shouldFix: boolean;
}

export async function triageAgent(userId: string, code: string, context?: string): Promise<TriageResult> {
  const relevantMemory = await searchMemory(userId, code, 3);
  const memoryContext = relevantMemory.length > 0
    ? `\nRelevant past context:\n${relevantMemory.map((m) => `[${m.role}]: ${m.content}`).join("\n")}`
    : "";

  const response = await groqChat([
    {
      role: "system",
      content: `You are the SORK Triage Agent — a senior security engineer. Analyze code for vulnerabilities (OWASP Top 10, injection, auth issues, secrets, XSS, SSRF, etc.). Return a JSON object with this exact shape:
{
  "severity": "critical|high|medium|low|info",
  "issues": [{"title": string, "description": string, "file": string|null, "line": number|null}],
  "summary": string,
  "shouldFix": boolean
}
Only return valid JSON, no markdown.`,
    },
    {
      role: "user",
      content: `Analyze this code:${memoryContext}${context ? `\nContext: ${context}` : ""}\n\n\`\`\`\n${code}\n\`\`\``,
    },
  ]);

  try {
    return JSON.parse(response) as TriageResult;
  } catch {
    return {
      severity: "info",
      issues: [],
      summary: response,
      shouldFix: false,
    };
  }
}
