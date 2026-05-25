/**
 * Cross-Scan Security Memory
 *
 * Tracks vulnerability patterns across scans per user/project.
 * Detects recurring issues, suggests bulk fixes, remembers what was fixed.
 */

import { db } from "../db/index.js";
import { vulnPatterns, scanSnapshots } from "../db/schema.js";
import { eq, and, desc, isNull, sql, inArray } from "drizzle-orm";
import { callEmbed } from "./router.js";
import { createHash } from "crypto";

interface TriageIssue {
  id: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  cwe?: string;
  fix_hint?: string;
  snippet?: string;
}

interface PatternMatch {
  patternId: string;
  title: string;
  category: string;
  cwe: string | null;
  severity: string;
  occurrences: number;
  filesAffected: string[];
  lastSeenAt: Date;
  fixHint: string | null;
}

function hashPattern(category: string, cwe: string | undefined, title: string): string {
  const normalized = `${category}::${cwe ?? "none"}::${title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 32);
}

export async function recordScanSnapshot(
  userId: string,
  sessionId: string,
  fileName: string | undefined,
  language: string | undefined,
  code: string,
  triageResult: { issues?: TriageIssue[] },
  fixApplied: boolean,
  fixJson?: unknown,
  verifyScore?: number,
): Promise<void> {
  const cHash = hashCode(code);
  const issueIds = (triageResult.issues ?? []).map(i => i.id);

  await db.insert(scanSnapshots).values({
    userId,
    sessionId,
    fileName: fileName ?? null,
    language: language ?? null,
    codeHash: cHash,
    issueIds,
    triageJson: triageResult,
    fixApplied,
    fixJson: fixJson ?? null,
    verifyScore: verifyScore ?? null,
  });
}

export async function trackVulnPatterns(
  userId: string,
  fileName: string | undefined,
  issues: TriageIssue[],
): Promise<{ newPatterns: number; recurringPatterns: PatternMatch[] }> {
  const recurring: PatternMatch[] = [];
  let newCount = 0;

  // Compute all hashes upfront
  const issueHashes = issues.map(issue => ({
    issue,
    hash: hashPattern(issue.category, issue.cwe, issue.title),
  }));
  const allHashes = issueHashes.map(h => h.hash);

  // Single batch query — fetch all existing patterns at once
  const existingPatterns = allHashes.length > 0
    ? await db
        .select()
        .from(vulnPatterns)
        .where(and(eq(vulnPatterns.userId, userId), inArray(vulnPatterns.patternHash, allHashes)))
    : [];

  const existingMap = new Map(existingPatterns.map(p => [p.patternHash, p]));

  for (const { issue, hash } of issueHashes) {
    const pattern = existingMap.get(hash);

    if (pattern) {
      const files = (pattern.filesAffected as string[]) ?? [];
      if (fileName && !files.includes(fileName)) {
        files.push(fileName);
      }

      await db
        .update(vulnPatterns)
        .set({
          occurrences: (pattern.occurrences ?? 1) + 1,
          filesAffected: files,
          lastSeenAt: new Date(),
          resolvedAt: null,
        })
        .where(eq(vulnPatterns.id, pattern.id));

      recurring.push({
        patternId: pattern.id,
        title: pattern.title,
        category: pattern.category,
        cwe: pattern.cwe,
        severity: pattern.severity,
        occurrences: (pattern.occurrences ?? 1) + 1,
        filesAffected: files,
        lastSeenAt: new Date(),
        fixHint: pattern.fixHint,
      });
    } else {
      let embedding: string | undefined;
      try {
        const vec = await callEmbed(userId, `${issue.category} ${issue.title} ${issue.description}`);
        if (vec.length > 0) embedding = JSON.stringify(vec);
      } catch { /* best effort */ }

      await db.insert(vulnPatterns).values({
        userId,
        patternHash: hash,
        category: issue.category,
        cwe: issue.cwe ?? null,
        title: issue.title,
        description: issue.description,
        fixHint: issue.fix_hint ?? null,
        severity: issue.severity,
        occurrences: 1,
        filesAffected: fileName ? [fileName] : [],
        embedding,
      });
      newCount++;
    }
  }

  return { newPatterns: newCount, recurringPatterns: recurring };
}

export async function markPatternsResolved(userId: string, issueCategories: string[]): Promise<number> {
  let resolved = 0;
  for (const category of issueCategories) {
    const result = await db
      .update(vulnPatterns)
      .set({ resolvedAt: new Date() })
      .where(and(eq(vulnPatterns.userId, userId), eq(vulnPatterns.category, category), isNull(vulnPatterns.resolvedAt)));
    resolved++;
  }
  return resolved;
}

export async function getRecurringPatterns(userId: string, topK = 10): Promise<PatternMatch[]> {
  const rows = await db
    .select()
    .from(vulnPatterns)
    .where(and(eq(vulnPatterns.userId, userId), isNull(vulnPatterns.resolvedAt)))
    .orderBy(desc(vulnPatterns.occurrences))
    .limit(topK);

  return rows.map(r => ({
    patternId: r.id,
    title: r.title,
    category: r.category,
    cwe: r.cwe,
    severity: r.severity,
    occurrences: r.occurrences ?? 1,
    filesAffected: (r.filesAffected as string[]) ?? [],
    lastSeenAt: r.lastSeenAt,
    fixHint: r.fixHint,
  }));
}

export async function getPatternInsights(userId: string): Promise<string> {
  const patterns = await getRecurringPatterns(userId, 5);
  if (patterns.length === 0) return "";

  const recurring = patterns.filter(p => p.occurrences > 1);
  if (recurring.length === 0) return "";

  let insight = "\n\n## Pattern Intelligence\n";
  insight += `SORK has detected **${recurring.length} recurring vulnerability pattern${recurring.length > 1 ? "s" : ""}** in your codebase:\n\n`;

  for (const p of recurring) {
    const fileCount = p.filesAffected.length;
    insight += `- **${p.title}** (${p.severity}) — seen **${p.occurrences}x** across ${fileCount} file${fileCount !== 1 ? "s" : ""}`;
    if (p.cwe) insight += ` [${p.cwe}]`;
    if (p.fixHint) insight += `\n  _Fix: ${p.fixHint}_`;
    insight += "\n";
  }

  insight += `\n_Say "fix all ${recurring[0].category} issues" to batch-fix the most common pattern._`;
  return insight;
}

export async function searchSimilarPatterns(userId: string, query: string, topK = 3): Promise<PatternMatch[]> {
  try {
    const queryVec = await callEmbed(userId, query);
    if (!queryVec?.length) return [];

    const rows = await db
      .select()
      .from(vulnPatterns)
      .where(and(eq(vulnPatterns.userId, userId), isNull(vulnPatterns.resolvedAt)))
      .limit(50);

    const scored = rows
      .filter(r => r.embedding)
      .map(r => {
        const vec = JSON.parse(r.embedding!) as number[];
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < vec.length; i++) {
          dot += queryVec[i] * vec[i];
          normA += queryVec[i] * queryVec[i];
          normB += vec[i] * vec[i];
        }
        const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
        return { ...r, score: sim };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored.map(r => ({
      patternId: r.id,
      title: r.title,
      category: r.category,
      cwe: r.cwe,
      severity: r.severity,
      occurrences: r.occurrences ?? 1,
      filesAffected: (r.filesAffected as string[]) ?? [],
      lastSeenAt: r.lastSeenAt,
      fixHint: r.fixHint,
    }));
  } catch {
    return [];
  }
}
