import { Hono } from "hono";
import { db } from "../db/index.js";
import {
  users, githubConnections, repositories, pullRequests, mergeConflicts,
} from "../db/schema.js";
import { eq } from "drizzle-orm";
import { clerkAuth } from "../middleware/auth.js";
import type { HonoEnv } from "../types.js";
import { Octokit } from "@octokit/rest";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const app = new Hono<HonoEnv>();

/* ── helpers ─────────────────────────────────────────── */
async function ensureUser(clerkId: string) {
  let user = await db.query.users.findFirst({ where: eq(users.clerkId, clerkId) });
  if (!user) {
    const [u] = await db.insert(users).values({ clerkId, email: `${clerkId}@sork.local` }).returning();
    user = u;
  }
  return user!;
}

async function getUserOctokit(clerkId: string): Promise<Octokit | null> {
  const user = await ensureUser(clerkId);
  const conn = await db.query.githubConnections.findFirst({
    where: eq(githubConnections.userId, user.id),
  });
  if (!conn) return null;
  return new Octokit({ auth: conn.accessToken });
}

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  try { return JSON.parse(fence ? fence[1] : text); } catch { return {}; }
}

const LANG_MAP: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", rb: "ruby", php: "php",
  json: "json", yaml: "yaml", yml: "yaml", md: "markdown", sh: "bash",
};

/* ── GitHub OAuth ────────────────────────────────────── */

app.get("/oauth/init", clerkAuth, (c) => {
  const clerkId = c.get("userId");
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ error: "GitHub OAuth not configured — set GITHUB_CLIENT_ID" }, 503);
  const state = Buffer.from(JSON.stringify({ clerkId, ts: Date.now() })).toString("base64url");
  const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=repo,read:user,user:email&state=${state}`;
  return c.json({ url });
});

app.get("/oauth/callback", async (c) => {
  const { code, state } = c.req.query();
  if (!code || !state) return c.json({ error: "Missing code or state" }, 400);

  let clerkId: string;
  try {
    clerkId = JSON.parse(Buffer.from(state, "base64url").toString()).clerkId;
  } catch {
    return c.json({ error: "Invalid state" }, 400);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const td = await tokenRes.json() as { access_token?: string; scope?: string; error?: string };
  if (!td.access_token) return c.json({ error: td.error ?? "Token exchange failed" }, 400);

  const octokit = new Octokit({ auth: td.access_token });
  const { data: gh } = await octokit.users.getAuthenticated();
  const user = await ensureUser(clerkId);

  const existing = await db.query.githubConnections.findFirst({
    where: eq(githubConnections.userId, user.id),
  });
  const payload = {
    githubUserId: String(gh.id),
    githubUsername: gh.login,
    githubEmail: gh.email ?? undefined,
    accessToken: td.access_token,
    scope: td.scope,
    avatarUrl: gh.avatar_url,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(githubConnections).set(payload).where(eq(githubConnections.id, existing.id));
  } else {
    await db.insert(githubConnections).values({ userId: user.id, ...payload });
  }

  const base = process.env.FRONTEND_URL ?? "https://sorkcloud.space";
  return c.redirect(`${base}/dashboard?view=repos&connected=true`);
});

/* ── Connection status ───────────────────────────────── */

app.get("/status", clerkAuth, async (c) => {
  const user = await ensureUser(c.get("userId"));
  const conn = await db.query.githubConnections.findFirst({
    where: eq(githubConnections.userId, user.id),
  });
  if (!conn) return c.json({ connected: false });
  return c.json({
    connected: true,
    username: conn.githubUsername,
    avatarUrl: conn.avatarUrl,
    scope: conn.scope,
  });
});

app.delete("/disconnect", clerkAuth, async (c) => {
  const user = await ensureUser(c.get("userId"));
  await db.delete(githubConnections).where(eq(githubConnections.userId, user.id));
  return c.json({ ok: true });
});

/* ── Repositories ────────────────────────────────────── */

app.get("/repos", clerkAuth, async (c) => {
  const octokit = await getUserOctokit(c.get("userId"));
  if (!octokit) return c.json({ error: "GitHub not connected", code: "NOT_CONNECTED" }, 401);

  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: "updated", per_page: 50, affiliation: "owner,collaborator",
  });

  return c.json({
    repos: data.map(r => ({
      id: String(r.id),
      owner: r.owner.login,
      name: r.name,
      fullName: r.full_name,
      isPrivate: r.private,
      defaultBranch: r.default_branch,
      language: r.language ?? null,
      description: r.description ?? null,
      stars: r.stargazers_count ?? 0,
      openIssues: r.open_issues_count ?? 0,
      updatedAt: r.updated_at,
      htmlUrl: r.html_url,
    })),
  });
});

/* ── Pull Requests ───────────────────────────────────── */

app.get("/repos/:owner/:repo/pulls", clerkAuth, async (c) => {
  const { owner, repo } = c.req.param();
  const octokit = await getUserOctokit(c.get("userId"));
  if (!octokit) return c.json({ error: "GitHub not connected", code: "NOT_CONNECTED" }, 401);

  const { data: prs } = await octokit.pulls.list({
    owner, repo, state: "open", per_page: 30, sort: "updated",
  });

  const enriched = await Promise.allSettled(prs.map(async pr => {
    let conflictCount = 0;
    let mergeable: boolean | null = null;
    try {
      const { data: detail } = await octokit.pulls.get({ owner, repo, pull_number: pr.number });
      mergeable = detail.mergeable;
      if (detail.mergeable === false) {
        const { data: files } = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
        conflictCount = files.length; // approximate: all changed files
      }
    } catch { /* best effort */ }

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "",
      authorAvatar: pr.user?.avatar_url ?? "",
      sourceBranch: pr.head.ref,
      targetBranch: pr.base.ref,
      state: pr.state,
      mergeable,
      conflictCount,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      htmlUrl: pr.html_url,
      reviewers: pr.requested_reviewers?.map(r => r.login) ?? [],
      labels: pr.labels?.map(l => ({ name: l.name, color: l.color })) ?? [],
    };
  }));

  return c.json({
    pulls: enriched
      .filter(r => r.status === "fulfilled")
      .map(r => (r as PromiseFulfilledResult<unknown>).value),
  });
});

/* ── Conflict details for a PR ───────────────────────── */

app.get("/repos/:owner/:repo/pulls/:number/conflicts", clerkAuth, async (c) => {
  const { owner, repo, number } = c.req.param();
  const octokit = await getUserOctokit(c.get("userId"));
  if (!octokit) return c.json({ error: "GitHub not connected", code: "NOT_CONNECTED" }, 401);

  const prNum = parseInt(number);
  const [{ data: pr }, { data: files }] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNum }),
    octokit.pulls.listFiles({ owner, repo, pull_number: prNum }),
  ]);

  const conflicts = await Promise.allSettled(
    files.slice(0, 15).map(async file => {
      let currentCode = "";
      let incomingCode = "";
      try {
        const { data: headFile } = await octokit.repos.getContent({
          owner, repo, path: file.filename, ref: pr.head.ref,
        });
        if (!Array.isArray(headFile) && "content" in headFile)
          currentCode = Buffer.from(headFile.content, "base64").toString("utf-8");
      } catch { /* file may not exist on head */ }

      try {
        const { data: baseFile } = await octokit.repos.getContent({
          owner, repo, path: file.filename, ref: pr.base.ref,
        });
        if (!Array.isArray(baseFile) && "content" in baseFile)
          incomingCode = Buffer.from(baseFile.content, "base64").toString("utf-8");
      } catch { /* file may not exist on base */ }

      const ext = file.filename.split(".").pop() ?? "";
      return {
        filePath: file.filename,
        language: LANG_MAP[ext] ?? ext,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? "",
        currentCode: currentCode.slice(0, 8000),
        incomingCode: incomingCode.slice(0, 8000),
      };
    })
  );

  return c.json({
    prTitle: pr.title,
    sourceBranch: pr.head.ref,
    targetBranch: pr.base.ref,
    mergeable: pr.mergeable,
    conflicts: conflicts
      .filter(r => r.status === "fulfilled")
      .map(r => (r as PromiseFulfilledResult<unknown>).value),
  });
});

/* ── AI merge resolution ─────────────────────────────── */

app.post("/resolve/ai", clerkAuth, async (c) => {
  const { filePath, language, currentCode, incomingCode, baseCode } = await c.req.json();

  const prompt = `You are an expert ${language} developer resolving a git merge conflict.

File: ${filePath}
Language: ${language}

── CURRENT BRANCH (HEAD) ──
\`\`\`${language}
${currentCode?.slice(0, 5000) ?? ""}
\`\`\`

── INCOMING BRANCH ──
\`\`\`${language}
${incomingCode?.slice(0, 5000) ?? ""}
\`\`\`

${baseCode ? `── BASE (common ancestor) ──\n\`\`\`${language}\n${baseCode.slice(0, 3000)}\n\`\`\`` : ""}

Produce the optimal merged version:
- Preserve all intended changes from both branches
- Resolve conflicts intelligently without losing logic
- No merge conflict markers (<<<, ===, >>>) in output
- Maintain code style and correctness

Respond with valid JSON only:
{
  "resolvedCode": "...",
  "explanation": "...",
  "confidence": 0.0,
  "strategy": "took_current|took_incoming|merged_both|custom",
  "risks": ["..."],
  "linesChanged": 0
}`;

  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    });
    const result = extractJson(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

/* ── Push resolved file to GitHub ────────────────────── */

app.post("/resolve/push", clerkAuth, async (c) => {
  const { owner, repo, branch, filePath, resolvedCode, commitMessage } = await c.req.json();
  const octokit = await getUserOctokit(c.get("userId"));
  if (!octokit) return c.json({ error: "GitHub not connected", code: "NOT_CONNECTED" }, 401);

  try {
    let sha: string | undefined;
    try {
      const { data: existing } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
      if (!Array.isArray(existing) && "sha" in existing) sha = existing.sha;
    } catch { /* new file */ }

    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: filePath,
      message: commitMessage ?? `fix: resolve merge conflict in ${filePath} via SORK AI`,
      content: Buffer.from(resolvedCode).toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    });

    return c.json({ ok: true, commitSha: data.commit.sha, commitUrl: data.commit.html_url });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
});

/* ── PR Review AI ────────────────────────────────────── */

app.post("/repos/:owner/:repo/pulls/:number/review", clerkAuth, async (c) => {
  const { owner, repo, number } = c.req.param();
  const octokit = await getUserOctokit(c.get("userId"));
  if (!octokit) return c.json({ error: "GitHub not connected", code: "NOT_CONNECTED" }, 401);

  const prNum = parseInt(number);
  const [{ data: pr }, { data: files }] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNum }),
    octokit.pulls.listFiles({ owner, repo, pull_number: prNum }),
  ]);

  const diffSummary = files.slice(0, 8).map(f =>
    `${f.filename} (+${f.additions}/-${f.deletions})\n${(f.patch ?? "").slice(0, 800)}`
  ).join("\n\n");

  const prompt = `Review this Pull Request and provide security + quality analysis.

PR: "${pr.title}"
${pr.body ? `Description: ${pr.body.slice(0, 500)}` : ""}
Branch: ${pr.head.ref} → ${pr.base.ref}
Files changed: ${files.length} (+${pr.additions}/-${pr.deletions})

Diff summary:
${diffSummary}

Respond JSON only:
{
  "summary": "...",
  "securityIssues": [{ "severity": "critical|high|medium|low", "file": "...", "description": "...", "recommendation": "..." }],
  "qualityIssues": [{ "type": "...", "file": "...", "description": "..." }],
  "strengths": ["..."],
  "riskScore": 0-100,
  "recommendation": "approve|request_changes|comment",
  "reviewComment": "..."
}`;

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2, max_tokens: 2048,
  });
  const result = extractJson(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  return c.json({ ok: true, prNumber: prNum, ...result });
});

export default app;
