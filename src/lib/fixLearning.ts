/**
 * Fix Learning Engine
 *
 * Captures user edits to AI-proposed fixes and builds a preference model.
 * When users override AI fixes, SORK learns their preferred patterns and
 * adapts future suggestions accordingly.
 */

import { db } from "../db/index.js";
import { fixEdits, fixPreferences } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";
import { callEmbed } from "./router.js";

interface EditDelta {
  aiCode: string;
  userCode: string;
  category: string;
  severity: string;
  patternId?: string;
}

interface LearnedPreference {
  category: string;
  preferredPattern: string;
  confidence: number;
  sampleCount: number;
}

function classifyEdit(aiCode: string, userCode: string): string {
  if (aiCode.trim() === userCode.trim()) return "accepted";

  const aiLines = aiCode.split("\n");
  const userLines = userCode.split("\n");
  const changed = userLines.filter((l, i) => aiLines[i] !== l).length;
  const ratio = changed / Math.max(userLines.length, 1);

  if (ratio < 0.1) return "minor_tweak";
  if (ratio < 0.3) return "partial_override";
  if (ratio < 0.6) return "major_override";
  return "full_rewrite";
}

function computeDiffDelta(aiCode: string, userCode: string): string {
  const aiLines = aiCode.split("\n");
  const userLines = userCode.split("\n");
  const diffs: string[] = [];

  const maxLen = Math.max(aiLines.length, userLines.length);
  for (let i = 0; i < maxLen; i++) {
    const ai = aiLines[i];
    const user = userLines[i];
    if (ai !== user) {
      if (ai !== undefined) diffs.push(`- ${ai}`);
      if (user !== undefined) diffs.push(`+ ${user}`);
    }
  }

  return diffs.join("\n");
}

function extractPattern(userCode: string, category: string): string {
  const lower = userCode.toLowerCase();

  if (category === "xss" || category === "injection") {
    if (/dompurify/i.test(lower)) return "dompurify_sanitization";
    if (/escape/i.test(lower)) return "escape_function";
    if (/textcontent/i.test(lower)) return "textcontent_over_innerhtml";
    if (/createelement/i.test(lower)) return "dom_api_creation";
    if (/parameteri[sz]ed|prepared/i.test(lower)) return "parameterized_queries";
  }

  if (category === "auth") {
    if (/jwt/i.test(lower)) return "jwt_auth";
    if (/session/i.test(lower)) return "session_auth";
    if (/bearer/i.test(lower)) return "bearer_token";
    if (/middleware/i.test(lower)) return "auth_middleware";
  }

  if (category === "crypto") {
    if (/bcrypt/i.test(lower)) return "bcrypt_hashing";
    if (/argon2/i.test(lower)) return "argon2_hashing";
    if (/scrypt/i.test(lower)) return "scrypt_hashing";
    if (/aes-256|aes256/i.test(lower)) return "aes256_encryption";
  }

  if (category === "secrets") {
    if (/env/i.test(lower)) return "env_variables";
    if (/vault/i.test(lower)) return "vault_secrets";
    if (/config/i.test(lower)) return "config_file";
  }

  return "custom_pattern";
}

export async function recordFixEdit(
  userId: string,
  delta: EditDelta,
): Promise<{ editType: string; patternLearned: string | null }> {
  const editType = classifyEdit(delta.aiCode, delta.userCode);
  const diffDelta = computeDiffDelta(delta.aiCode, delta.userCode);

  if (editType === "accepted") {
    return { editType, patternLearned: null };
  }

  let embedding: string | undefined;
  try {
    const vec = await callEmbed(userId, `${delta.category} fix override: ${diffDelta.slice(0, 500)}`);
    if (vec.length > 0) embedding = JSON.stringify(vec);
  } catch { /* best effort */ }

  await db.insert(fixEdits).values({
    userId,
    patternId: delta.patternId ?? null,
    category: delta.category,
    severity: delta.severity,
    aiProposedCode: delta.aiCode.slice(0, 20000),
    userFinalCode: delta.userCode.slice(0, 20000),
    diffDelta: diffDelta.slice(0, 10000),
    editType,
    embedding,
  });

  const pattern = extractPattern(delta.userCode, delta.category);
  await updatePreference(userId, delta.category, pattern);

  return { editType, patternLearned: pattern };
}

async function updatePreference(userId: string, category: string, pattern: string): Promise<void> {
  const existing = await db
    .select()
    .from(fixPreferences)
    .where(and(eq(fixPreferences.userId, userId), eq(fixPreferences.category, category)))
    .limit(1);

  if (existing.length > 0) {
    const pref = existing[0];
    const newCount = (pref.sampleCount ?? 1) + 1;
    const isSamePattern = pref.preferredPattern === pattern;
    const newConfidence = isSamePattern
      ? Math.min(100, (pref.confidence ?? 50) + 10)
      : Math.max(20, (pref.confidence ?? 50) - 5);

    await db
      .update(fixPreferences)
      .set({
        preferredPattern: isSamePattern ? pattern : (newConfidence < 40 ? pattern : pref.preferredPattern),
        confidence: newConfidence,
        sampleCount: newCount,
        lastAppliedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(fixPreferences.id, pref.id));
  } else {
    await db.insert(fixPreferences).values({
      userId,
      category,
      preferredPattern: pattern,
      confidence: 50,
      sampleCount: 1,
    });
  }
}

export async function getFixPreferences(userId: string): Promise<LearnedPreference[]> {
  const rows = await db
    .select()
    .from(fixPreferences)
    .where(eq(fixPreferences.userId, userId))
    .orderBy(desc(fixPreferences.confidence));

  return rows.map(r => ({
    category: r.category,
    preferredPattern: r.preferredPattern,
    confidence: r.confidence ?? 50,
    sampleCount: r.sampleCount ?? 1,
  }));
}

export async function getRecentEdits(userId: string, category?: string, limit = 5): Promise<{
  editType: string;
  category: string;
  diffDelta: string | null;
  createdAt: Date;
}[]> {
  let query = db
    .select({
      editType: fixEdits.editType,
      category: fixEdits.category,
      diffDelta: fixEdits.diffDelta,
      createdAt: fixEdits.createdAt,
    })
    .from(fixEdits)
    .where(
      category
        ? and(eq(fixEdits.userId, userId), eq(fixEdits.category, category))
        : eq(fixEdits.userId, userId)
    )
    .orderBy(desc(fixEdits.createdAt))
    .limit(limit);

  return await query;
}

export function buildPreferenceHint(prefs: LearnedPreference[]): string {
  if (prefs.length === 0) return "";

  const highConf = prefs.filter(p => p.confidence >= 60 && p.sampleCount >= 2);
  if (highConf.length === 0) return "";

  let hint = "\n\n## User Fix Preferences (learned from past edits)\n";
  hint += "Apply these patterns when generating fixes — the user has consistently preferred them:\n\n";

  for (const p of highConf) {
    const readable = p.preferredPattern.replace(/_/g, " ");
    hint += `- **${p.category}**: use ${readable} (confidence: ${p.confidence}%, based on ${p.sampleCount} edits)\n`;
  }

  return hint;
}
