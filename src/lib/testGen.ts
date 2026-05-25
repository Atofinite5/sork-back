/**
 * Auto-Test Generation for Verified Fixes
 *
 * After fix + verify pipeline, generates a test case that proves
 * the vulnerability is patched. Ships alongside the fix diff.
 */

import { callLLM } from "./router.js";
import { extractJson } from "./parseJson.js";

interface TriageIssue {
  id: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  cwe?: string;
  snippet?: string;
}

export interface GeneratedTest {
  testCode: string;
  framework: string;
  description: string;
  coversIssues: string[];
}

const TEST_GEN_PROMPT = `You are SORK TestGen — a security test engineer. Given vulnerable code, its fix, and the triage report, generate a minimal test suite that:

1. Proves the original vulnerability EXISTS in the unfixed code (regression test)
2. Proves the vulnerability is ELIMINATED in the fixed code
3. Verifies no business logic was broken

Detect the language and use the appropriate testing framework:
- TypeScript/JavaScript → vitest or jest
- Python → pytest
- Go → testing package
- Rust → #[cfg(test)] mod tests
- Java → JUnit 5
- Default → pseudocode

Return ONLY valid JSON:
{
  "framework": "<test framework name>",
  "description": "<what the tests verify>",
  "coversIssues": ["SORK-001", "SORK-002"],
  "testCode": "<complete runnable test file>"
}

Rules:
- Tests must be RUNNABLE — no placeholders, no TODO comments
- Import the function/module being tested
- Test the attack vector specifically (e.g., SQL injection payload, XSS string)
- Keep tests minimal — one test per vulnerability
- Never expose real API keys or secrets in tests`;

export async function generateSecurityTests(
  userId: string,
  originalCode: string,
  fixedCode: string,
  issues: TriageIssue[],
  language?: string,
): Promise<GeneratedTest | null> {
  if (issues.length === 0) return null;

  const issueBlock = issues
    .filter(i => i.severity === "critical" || i.severity === "high" || i.severity === "medium")
    .map(i => {
      let line = `- [${i.id}] ${i.title} (${i.severity}, ${i.category})`;
      if (i.cwe) line += ` [${i.cwe}]`;
      line += `\n  ${i.description}`;
      if (i.snippet) line += `\n  Vulnerable: \`${i.snippet}\``;
      return line;
    })
    .join("\n");

  const prompt = [
    `## Language: ${language ?? "auto-detect"}`,
    `## Issues found`,
    issueBlock,
    `## Original (vulnerable) code`,
    "```",
    originalCode.slice(0, 6000),
    "```",
    `## Fixed (patched) code`,
    "```",
    fixedCode.slice(0, 6000),
    "```",
  ].join("\n");

  try {
    const result = await callLLM(
      userId,
      "heavy",
      [
        { role: "system", content: TEST_GEN_PROMPT },
        { role: "user", content: prompt },
      ],
      { temperature: 0.1, maxTokens: 4096 },
    );

    const parsed = extractJson<{
      framework?: string;
      description?: string;
      coversIssues?: string[];
      testCode?: string;
    }>(result.text);

    if (!parsed || !parsed.testCode) return null;

    return {
      testCode: parsed.testCode,
      framework: parsed.framework ?? "unknown",
      description: parsed.description ?? "Security regression tests",
      coversIssues: parsed.coversIssues ?? issues.map(i => i.id),
    };
  } catch {
    return null;
  }
}
