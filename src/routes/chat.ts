import { Hono } from "hono";
import { groqChat } from "../lib/providers/groq.js";
import { checkContentSafety } from "../lib/providers/nemotron.js";
import { saveMemory, getRecentMemory, searchMemory } from "../agents/memory.js";
import { db } from "../db/index.js";
import { byokKeys, users } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { decryptKey } from "../lib/crypto.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import Groq from "groq-sdk";
import type { HonoEnv } from "../types.js";

const chat = new Hono<HonoEnv>();

// Available Groq models users can switch to
const GROQ_MODELS: Record<string, string> = {
  "llama-3.3-70b": "llama-3.3-70b-versatile",
  "llama-3.1-70b": "llama-3.1-70b-versatile",
  "llama-3.1-8b": "llama-3.1-8b-instant",
  "mixtral": "mixtral-8x7b-32768",
  "gemma2-9b": "gemma2-9b-it",
  "llama3-70b": "llama3-70b-8192",
  "llama3-8b": "llama3-8b-8192",
};

function detectModelSwitch(message: string): string | null {
  const lower = message.toLowerCase();

  // Explicit switch phrases
  const patterns = [
    /use\s+([\w\-\.]+)\s+(?:model|as model|for (?:chat|triage|scanning))/i,
    /switch(?:\s+to)?\s+([\w\-\.]+)/i,
    /change\s+(?:the\s+)?(?:model\s+)?to\s+([\w\-\.]+)/i,
    /set\s+(?:model\s+)?(?:to\s+)?([\w\-\.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match) {
      const candidate = match[1].toLowerCase();
      // Check known models
      for (const [key, value] of Object.entries(GROQ_MODELS)) {
        if (candidate.includes(key) || key.includes(candidate)) return value;
      }
      // If it looks like a model ID, use it directly
      if (candidate.includes("llama") || candidate.includes("mixtral") || candidate.includes("gemma")) {
        return candidate;
      }
    }
  }
  return null;
}

const chatSchema = z.object({
  message: z.string().min(1).max(12000),
  sessionId: z.string().optional(),
  hasAttachments: z.boolean().optional(),
  attachedFiles: z.array(z.object({ name: z.string(), size: z.number() })).optional(),
});

const SORK_SYSTEM = `You are SORK — an AI-powered security assistant embedded in SORK Cloud, a multi-agent security pipeline.

## Your persona
You are precise, technical, and direct. You think like a senior security engineer. When you explain vulnerabilities you cite the attack vector, impact, and remediation. When you reply, you structure your thoughts clearly.

## What you help with
- **Security findings**: explain vulnerabilities, CVEs, CWEs, attack vectors
- **BYOK setup**: help users add API endpoints (Groq, Claude, NVIDIA, OpenAI, Cohere, custom)
- **Model switching**: when user asks to switch model, confirm and explain the change
- **Code review**: if user pastes code, analyse it for security issues
- **Pipeline results**: interpret triage/fix/verify outputs

## Reply format rules (ALWAYS follow)
- Use **bold** for important terms, severity levels, model names
- Use bullet points (–) for lists, never asterisks for lists
- Use \`inline code\` for file names, model IDs, commands, code snippets
- Use numbered lists for step-by-step instructions
- Short paragraphs (2–3 sentences max)
- End with a clear action if one exists

## BYOK setup
When user wants to add an API key, ask for:
1. Provider (Groq, Claude/Anthropic, NVIDIA, OpenAI, Cohere, or Custom)
2. API key
3. Model (optional)
4. Base URL (only for Custom)
Then confirm they should use the **BYOK Manager** panel below the chat.

## Model switching
Available Groq models: llama-3.3-70b-versatile (default, best), llama-3.1-70b-versatile, llama-3.1-8b-instant (fastest), mixtral-8x7b-32768, gemma2-9b-it
When user switches model, say: "Switched to \`[model]\`. All future scans and triage will use this model."

Never expose or repeat API keys in your responses.`;

chat.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { message, sessionId = randomUUID(), hasAttachments, attachedFiles } = parsed.data;

  // Safety gate
  const safety = await checkContentSafety(message.slice(0, 1000));
  if (!safety.safe) {
    return c.json({ error: "Message blocked by content safety filter.", reason: safety.reason }, 400);
  }

  // Detect model switch intent
  const switchModel = detectModelSwitch(message);
  let modelSwitched = false;

  if (switchModel) {
    await db.update(users)
      .set({ preferredModel: switchModel, updatedAt: new Date() })
      .where(eq(users.id, userId));
    modelSwitched = true;
  }

  // Get user's preferred model
  const [userRow] = await db
    .select({ preferredModel: users.preferredModel })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const activeModel = switchModel ?? userRow?.preferredModel ?? "llama-3.3-70b-versatile";

  // Retrieve memory
  const recentMemory = await getRecentMemory(userId, sessionId, 10);
  const semanticMemory = await searchMemory(userId, message.slice(0, 300), 3);

  const memoryContext = semanticMemory.length > 0
    ? `\n\n## Relevant past context\n${semanticMemory.map((m) => `– ${m.content}`).join("\n")}`
    : "";

  const systemPrompt = SORK_SYSTEM + memoryContext;
  const history = recentMemory.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // Save user message
  const displayMessage = message.replace(/\n\nAttached files:[\s\S]*/m, "").trim();
  await saveMemory(userId, sessionId, "user", displayMessage);

  // Choose provider — use active BYOK if set, else inbuilt Groq
  const [byokKey] = await db
    .select()
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.active, true)))
    .limit(1);

  let reply: string;

  if (byokKey) {
    const decrypted = decryptKey(byokKey.encryptedKey);
    if (byokKey.provider === "groq") {
      const groq = new Groq({ apiKey: decrypted });
      const completion = await groq.chat.completions.create({
        messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
        model: byokKey.model ?? activeModel,
        temperature: 0.4,
        max_tokens: 1024,
      });
      reply = completion.choices[0]?.message?.content ?? "";
    } else {
      const openai = new OpenAI({ apiKey: decrypted, baseURL: byokKey.baseUrl ?? undefined });
      const completion = await openai.chat.completions.create({
        messages: [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
        model: byokKey.model ?? "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 1024,
      });
      reply = completion.choices[0]?.message?.content ?? "";
    }
  } else {
    reply = await groqChat(
      [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
      activeModel,
      0.4,
      1024
    );
  }

  await saveMemory(userId, sessionId, "assistant", reply.slice(0, 500));

  const byokIntent = /add.*(api|key|endpoint|provider)|byok|bring.*own/i.test(message);

  return c.json({
    reply,
    sessionId,
    byokIntent,
    modelSwitched,
    activeModel,
    ...(attachedFiles?.length ? { filesReceived: attachedFiles.length } : {}),
  });
});

// GET /chat/model — get user's current preferred model
chat.get("/model", async (c) => {
  const userId = c.get("userId") as string;
  const [userRow] = await db
    .select({ preferredModel: users.preferredModel })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return c.json({ model: userRow?.preferredModel ?? "llama-3.3-70b-versatile" });
});

export default chat;
