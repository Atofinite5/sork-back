/**
 * Fix Learning API Routes
 *
 * Receives user edit events from the diff editor,
 * returns learned preferences and pattern insights.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { HonoEnv } from "../types.js";
import { recordFixEdit, getFixPreferences, getRecentEdits } from "../lib/fixLearning.js";
import { getPatternInsights, getRecurringPatterns } from "../lib/scanMemory.js";

const fixlearn = new Hono<HonoEnv>();

/* ── POST /fixlearn/edit — record a user's edit to an AI fix ── */
fixlearn.post("/edit", async (c) => {
  const userId = c.get("userId") as string;

  const schema = z.object({
    aiCode: z.string().min(1).max(50000),
    userCode: z.string().min(1).max(50000),
    category: z.string().min(1).max(100),
    severity: z.string().min(1).max(20),
    patternId: z.string().uuid().optional(),
  });

  const body = await c.req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const result = await recordFixEdit(userId, parsed.data);

  return c.json({
    editType: result.editType,
    patternLearned: result.patternLearned,
    message: result.patternLearned
      ? `Learned your preference: ${result.patternLearned.replace(/_/g, " ")} for ${parsed.data.category} fixes.`
      : "Fix accepted as-is.",
  });
});

/* ── GET /fixlearn/preferences — get user's learned fix preferences ── */
fixlearn.get("/preferences", async (c) => {
  const userId = c.get("userId") as string;
  const prefs = await getFixPreferences(userId);
  return c.json({ preferences: prefs });
});

/* ── GET /fixlearn/history — recent fix edits ── */
fixlearn.get("/history", async (c) => {
  const userId = c.get("userId") as string;
  const category = c.req.query("category");
  const edits = await getRecentEdits(userId, category, 20);
  return c.json({ edits });
});

/* ── GET /fixlearn/insights — pattern intelligence summary ── */
fixlearn.get("/insights", async (c) => {
  const userId = c.get("userId") as string;
  const [insights, patterns, prefs] = await Promise.all([
    getPatternInsights(userId),
    getRecurringPatterns(userId, 10),
    getFixPreferences(userId),
  ]);

  return c.json({
    insights,
    patterns: patterns.map(p => ({
      id: p.patternId,
      title: p.title,
      category: p.category,
      severity: p.severity,
      occurrences: p.occurrences,
      filesAffected: p.filesAffected.length,
      cwe: p.cwe,
    })),
    preferences: prefs,
  });
});

export default fixlearn;
