import { Hono } from "hono";
import type { HonoEnv } from "../types.js";
import { groqChat } from "../lib/providers/groq.js";
import { checkContentSafety } from "../lib/providers/nemotron.js";
import { saveMemory, getRecentMemory, searchMemory } from "../agents/memory.js";
import { db } from "../db/index.js";
import { byokKeys } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { decryptKey } from "../lib/crypto.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import OpenAI from "openai";
import Groq from "groq-sdk";

const chat = new Hono<HonoEnv>();

const chatSchema = z.object({
  message: z.string().min(1).max(8000),
  sessionId: z.string().optional(),
});

// POST /chat — conversational BYOK setup + general SORK assistant
chat.post("/", async (c) => {
  const userId = c.get("userId") as string;
  const body = await c.req.json();
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  const { message, sessionId = randomUUID() } = parsed.data;

  // Safety gate
  const safety = await checkContentSafety(message);
  if (!safety.safe) {
    return c.json({ error: "Message blocked by safety filter.", reason: safety.reason }, 400);
  }

  // Retrieve relevant memory
  const recentMemory = await getRecentMemory(userId, sessionId, 8);
  const semanticMemory = await searchMemory(userId, message, 3);

  const systemPrompt = `You are SORK — an AI-powered security assistant embedded in SORK Cloud. You help developers:
1. Configure their API endpoints (Groq, Claude, NVIDIA, OpenAI, Cohere, custom)
2. Understand security scan results
3. Set up BYOK (bring your own key) providers
4. Run security pipelines on their code

When a user wants to add an API endpoint, ask for: provider name, API key, base URL (if custom), and preferred model.
Then confirm and tell them you've saved it — the frontend will handle the actual saving.

Respond in a helpful, concise, technical tone. Never expose user API keys in your responses.

Relevant past context:
${semanticMemory.map((m) => `[${m.role}]: ${m.content}`).join("\n")}`;

  const history = recentMemory.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
  }));

  // Save user message
  await saveMemory(userId, sessionId, "user", message);

  // Check if user has an active BYOK key to use instead of inbuilt Groq
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
        model: byokKey.model ?? "llama-3.3-70b-versatile",
        temperature: 0.4,
        max_tokens: 1024,
      });
      reply = completion.choices[0]?.message?.content ?? "";
    } else {
      // OpenAI-compatible for others
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
    // Default: inbuilt Groq
    reply = await groqChat(
      [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }],
      "llama-3.3-70b-versatile",
      0.4,
      1024
    );
  }

  // Save assistant reply to memory
  await saveMemory(userId, sessionId, "assistant", reply);

  // Detect BYOK intent from reply to help frontend pre-fill forms
  const byokIntent = /add.*(api|key|endpoint|provider)/i.test(message);

  return c.json({ reply, sessionId, byokIntent });
});

export default chat;
