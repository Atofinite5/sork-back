/**
 * CI/CD Integration Routes
 *
 * Webhook receiver for GitHub Actions. Scans PR diffs,
 * posts findings as PR comments with inline suggestions.
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID, createHash, timingSafeEqual } from "crypto";
import { db } from "../db/index.js";
import { ciWebhooks, ciScanRuns, users, licenseKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { callLLM } from "../lib/router.js";
import { extractJson } from "../lib/parseJson.js";
import { trackVulnPatterns } from "../lib/scanMemory.js";
import type { HonoEnv } from "../types.js";

const ci = new Hono<HonoEnv>();

const TRIAGE_PROMPT = `You are SORK CI — a security scanner for pull request diffs. Analyze ONLY the changed code for vulnerabilities.

Return ONLY valid JSON:
{
  "severity": "critical|high|medium|low|clean",
  "summary": "<one-line summary for PR comment>",
  "issues": [
    {
      "id": "SORK-001",
      "title": "<title>",
      "severity": "critical|high|medium|low",
      "category": "<injection|auth|secrets|xss|ssrf|crypto|logic|config|other>",
      "file": "<file path>",
      "line": <line number or null>,
      "description": "<what is wrong>",
      "suggestion": "<one-line fix suggestion>",
      "cwe": "CWE-XXX"
    }
  ]
}

Rules:
- Only flag issues with confidence >= 80%
- Focus on security — skip style, naming, formatting
- Be precise about file paths and line numbers`;

/* ── POST /ci/setup — register a webhook for a repo ── */
ci.post("/setup", async (c) => {
  const userId = c.get("userId") as string;

  const body = await c.req.json();
  const schema = z.object({
    repositoryId: z.string().uuid(),
    events: z.array(z.string()).optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const secret = `sork_wh_${randomUUID().replace(/-/g, "")}`;

  const [webhook] = await db.insert(ciWebhooks).values({
    userId,
    repositoryId: parsed.data.repositoryId,
    webhookSecret: secret,
    events: parsed.data.events ?? ["pull_request"],
  }).returning();

  return c.json({
    webhookId: webhook.id,
    secret,
    url: `${process.env.API_URL ?? "https://api.sorkcloud.space"}/ci/webhook/${webhook.id}`,
    events: webhook.events,
  });
});

/* ── POST /ci/webhook/:id — receive GitHub webhook ── */
ci.post("/webhook/:id", async (c) => {
  const webhookId = c.req.param("id");

  const [webhook] = await db
    .select()
    .from(ciWebhooks)
    .where(and(eq(ciWebhooks.id, webhookId), eq(ciWebhooks.active, true)))
    .limit(1);

  if (!webhook) return c.json({ error: "Webhook not found" }, 404);

  // Verify signature
  const signature = c.req.header("x-hub-signature-256");
  const rawBody = await c.req.text();

  if (signature) {
    const expected = "sha256=" + createHash("sha256")
      .update(webhook.webhookSecret)
      .update(rawBody)
      .digest("hex");

    try {
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return c.json({ error: "Invalid signature" }, 401);
      }
    } catch {
      return c.json({ error: "Invalid signature" }, 401);
    }
  }

  const event = c.req.header("x-github-event");
  if (event !== "pull_request") {
    return c.json({ ok: true, skipped: true, reason: `Event ${event} not handled` });
  }

  const payload = JSON.parse(rawBody) as {
    action?: string;
    pull_request?: {
      number: number;
      head: { sha: string; ref: string };
      base: { ref: string };
      title: string;
      diff_url: string;
    };
    repository?: { full_name: string; owner: { login: string }; name: string };
  };

  const action = payload.action;
  if (action !== "opened" && action !== "synchronize") {
    return c.json({ ok: true, skipped: true, reason: `Action ${action} not handled` });
  }

  const pr = payload.pull_request;
  const repo = payload.repository;
  if (!pr || !repo) return c.json({ error: "Missing PR or repo data" }, 400);

  // Create scan run record
  const [scanRun] = await db.insert(ciScanRuns).values({
    webhookId: webhook.id,
    userId: webhook.userId,
    prNumber: pr.number,
    commitSha: pr.head.sha,
    branch: pr.head.ref,
    status: "running",
  }).returning();

  // Fetch the diff (non-blocking — we'll update the record when done)
  processPRScan(webhook.userId, scanRun.id, repo.full_name, pr.number, pr.head.sha, pr.head.ref).catch(err => {
    console.error("[ci] scan error:", err);
  });

  return c.json({ ok: true, scanRunId: scanRun.id, status: "queued" });
});

async function processPRScan(
  userId: string,
  scanRunId: string,
  repoFullName: string,
  prNumber: number,
  commitSha: string,
  branch: string,
): Promise<void> {
  try {
    // Fetch diff via GitHub API
    const token = process.env.GITHUB_APP_TOKEN ?? process.env.GITHUB_TOKEN;
    const diffResp = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
      headers: {
        Accept: "application/vnd.github.v3.diff",
        Authorization: token ? `Bearer ${token}` : "",
        "User-Agent": "SORK-CI/1.0",
      },
    });

    if (!diffResp.ok) {
      await db.update(ciScanRuns).set({ status: "error" }).where(eq(ciScanRuns.id, scanRunId));
      return;
    }

    const diff = await diffResp.text();
    if (diff.length < 10) {
      await db.update(ciScanRuns).set({ status: "clean", findings: 0, completedAt: new Date() }).where(eq(ciScanRuns.id, scanRunId));
      return;
    }

    // Run triage on the diff
    const result = await callLLM(
      userId, "chat",
      [
        { role: "system", content: TRIAGE_PROMPT },
        { role: "user", content: `## PR #${prNumber} diff (${repoFullName})\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`` },
      ],
      { temperature: 0.1, maxTokens: 4096 },
    );

    interface CIIssue {
      id: string;
      title: string;
      severity: string;
      category: string;
      file: string;
      line: number | null;
      description: string;
      suggestion: string;
      cwe?: string;
    }
    interface CITriage {
      severity?: string;
      summary?: string;
      issues?: CIIssue[];
    }

    const triage = extractJson<CITriage>(result.text);
    const issues = triage?.issues ?? [];
    const criticalCount = issues.filter(i => i.severity === "critical").length;
    const highCount = issues.filter(i => i.severity === "high").length;

    // Track patterns in memory
    if (issues.length > 0) {
      await trackVulnPatterns(
        userId,
        `PR#${prNumber}:${branch}`,
        issues.map(i => ({
          id: i.id,
          title: i.title,
          description: i.description,
          severity: i.severity,
          category: i.category,
          cwe: i.cwe,
        })),
      );
    }

    // Build PR comment
    const comment = buildPRComment(triage, issues, commitSha);

    // Post comment to GitHub
    let commentId: string | undefined;
    if (token) {
      try {
        const commentResp = await fetch(
          `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "SORK-CI/1.0",
            },
            body: JSON.stringify({ body: comment }),
          },
        );
        if (commentResp.ok) {
          const commentData = await commentResp.json() as { id: number };
          commentId = String(commentData.id);
        }
      } catch {
        // comment posting is best-effort
      }
    }

    await db
      .update(ciScanRuns)
      .set({
        status: issues.length > 0 ? "findings" : "clean",
        findings: issues.length,
        critical: criticalCount,
        high: highCount,
        commentId,
        completedAt: new Date(),
      })
      .where(eq(ciScanRuns.id, scanRunId));

  } catch (err) {
    console.error("[ci] processPRScan error:", err);
    await db.update(ciScanRuns).set({ status: "error" }).where(eq(ciScanRuns.id, scanRunId));
  }
}

function buildPRComment(
  triage: { severity?: string; summary?: string } | null,
  issues: { id: string; title: string; severity: string; category: string; file: string; line: number | null; description: string; suggestion: string; cwe?: string }[],
  commitSha: string,
): string {
  const sevIcon = (s: string) => s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "🟢";

  let comment = `## 🛡️ SORK Security Scan\n\n`;
  comment += `**Commit:** \`${commitSha.slice(0, 7)}\` | `;

  if (issues.length === 0) {
    comment += `**Status:** ✅ Clean\n\n`;
    comment += `No security issues detected in this PR.\n\n`;
    comment += `---\n_Powered by [SORK](https://sorkcloud.space) — AI Security Engineering_`;
    return comment;
  }

  const critCount = issues.filter(i => i.severity === "critical").length;
  const highCount = issues.filter(i => i.severity === "high").length;

  comment += `**Findings:** ${issues.length} | `;
  if (critCount > 0) comment += `🔴 ${critCount} critical `;
  if (highCount > 0) comment += `🟠 ${highCount} high`;
  comment += `\n\n`;

  if (triage?.summary) {
    comment += `> ${triage.summary}\n\n`;
  }

  comment += `### Findings\n\n`;
  comment += `| | ID | Severity | File | Issue | Suggestion |\n`;
  comment += `|---|---|---|---|---|---|\n`;

  for (const issue of issues.slice(0, 15)) {
    const loc = issue.line ? `${issue.file}#L${issue.line}` : issue.file;
    comment += `| ${sevIcon(issue.severity)} | ${issue.id} | ${issue.severity} | \`${loc}\` | ${issue.title} | ${issue.suggestion} |\n`;
  }

  if (issues.length > 15) {
    comment += `\n_...and ${issues.length - 15} more findings._\n`;
  }

  if (critCount + highCount > 0) {
    comment += `\n### ⚠️ Action Required\n`;
    comment += `This PR has **${critCount + highCount} critical/high severity** findings that should be addressed before merge.\n`;
  }

  comment += `\n---\n_Powered by [SORK](https://sorkcloud.space) — AI Security Engineering_`;
  return comment;
}

/* ── POST /ci/scan — direct scan endpoint for GitHub Action (license key auth) ── */
ci.post("/scan", async (c) => {
  const userId = c.get("userId") as string;

  const schema = z.object({
    diff: z.string().min(1).max(100000),
    repo: z.string(),
    pr: z.number(),
    commit: z.string(),
    branch: z.string(),
    mode: z.enum(["diff", "full"]).optional(),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { diff, repo, pr, commit, branch } = parsed.data;

  const result = await callLLM(
    userId, "chat",
    [
      { role: "system", content: TRIAGE_PROMPT },
      { role: "user", content: `## PR #${pr} diff (${repo})\n\n\`\`\`diff\n${diff.slice(0, 12000)}\n\`\`\`` },
    ],
    { temperature: 0.1, maxTokens: 4096 },
  );

  interface ScanIssue {
    id: string; title: string; severity: string; category: string;
    file: string; line: number | null; description: string; suggestion: string; cwe?: string;
  }
  const triage = extractJson<{ severity?: string; summary?: string; issues?: ScanIssue[] }>(result.text);
  const issues = triage?.issues ?? [];

  if (issues.length > 0) {
    await trackVulnPatterns(
      userId,
      `PR#${pr}:${branch}`,
      issues.map(i => ({
        id: i.id, title: i.title, description: i.description,
        severity: i.severity, category: i.category, cwe: i.cwe,
      })),
    );
  }

  const comment = buildPRComment(triage, issues, commit);

  return c.json({
    status: issues.length > 0 ? "findings" : "clean",
    findings: issues.length,
    critical: issues.filter(i => i.severity === "critical").length,
    high: issues.filter(i => i.severity === "high").length,
    issues,
    comment,
  });
});

/* ── GET /ci/runs — list scan runs for a user ── */
ci.get("/runs", async (c) => {
  const userId = c.get("userId") as string;
  const runs = await db
    .select()
    .from(ciScanRuns)
    .where(eq(ciScanRuns.userId, userId))
    .orderBy(ciScanRuns.createdAt)
    .limit(50);

  return c.json({ runs });
});

/* ── GET /ci/webhooks — list configured webhooks ── */
ci.get("/webhooks", async (c) => {
  const userId = c.get("userId") as string;
  const webhooks = await db
    .select({
      id: ciWebhooks.id,
      repositoryId: ciWebhooks.repositoryId,
      active: ciWebhooks.active,
      events: ciWebhooks.events,
      createdAt: ciWebhooks.createdAt,
    })
    .from(ciWebhooks)
    .where(eq(ciWebhooks.userId, userId));

  return c.json({ webhooks });
});

export default ci;
