/**
 * Multi-agent provider router.
 *
 * Routes tasks to the best provider based on user's active BYOK keys.
 * Falls back to inbuilt defaults if user hasn't connected that provider.
 *
 * Architecture:
 *   chat   → Groq (fast llama-3.3-70b)
 *   embed  → Cohere (embed-english-v3.0)
 *   heavy  → NVIDIA NIM (Nemotron / large models for complex reasoning)
 *   safety → NVIDIA Nemotron safety guardrails
 */

import Groq from "groq-sdk";
import OpenAI from "openai";
import { db } from "../db/index.js";
import { byokKeys } from "../db/schema.js";
import { and, eq } from "drizzle-orm";
import { decryptKey } from "./crypto.js";

export type Task = "chat" | "embed" | "heavy" | "safety";

interface ResolvedProvider {
  source: "byok" | "inbuilt";
  provider: string;
  apiKey: string;
  baseURL?: string;
  model: string;
}

const INBUILT_DEFAULTS: Record<Task, ResolvedProvider> = {
  chat: {
    source: "inbuilt",
    provider: "groq",
    apiKey: process.env.GROQ_API_KEY ?? "",
    model: "llama-3.3-70b-versatile",
  },
  embed: {
    source: "inbuilt",
    provider: "cohere",
    apiKey: process.env.COHERE_API_KEY ?? "",
    baseURL: "https://api.cohere.ai/v1",
    model: "embed-english-v3.0",
  },
  heavy: {
    source: "inbuilt",
    provider: "nvidia",
    apiKey: process.env.NVIDIA_API_KEY ?? "",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-3.3-70b-instruct",
  },
  safety: {
    source: "inbuilt",
    provider: "nvidia",
    apiKey: process.env.NVIDIA_API_KEY ?? "",
    baseURL: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/llama-3.1-nemotron-70b-instruct",
  },
};

const BYOK_PREFERENCE: Record<Task, string[]> = {
  chat:   ["groq", "openai", "nvidia", "custom"],
  embed:  ["cohere", "openai"],
  heavy:  ["nvidia", "anthropic", "openai", "groq"],
  safety: ["nvidia", "anthropic"],
};

const PROVIDER_BASE: Record<string, string> = {
  groq:      "https://api.groq.com/openai/v1",
  nvidia:    "https://integrate.api.nvidia.com/v1",
  openai:    "https://api.openai.com/v1",
  cohere:    "https://api.cohere.ai/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const PROVIDER_DEFAULT_MODEL: Record<string, Record<Task, string>> = {
  groq: {
    chat:   "llama-3.3-70b-versatile",
    embed:  "",
    heavy:  "llama-3.3-70b-versatile",
    safety: "llama-3.3-70b-versatile",
  },
  nvidia: {
    chat:   "meta/llama-3.3-70b-instruct",
    embed:  "",
    heavy:  "nvidia/llama-3.1-nemotron-70b-instruct",
    safety: "nvidia/llama-3.1-nemotron-70b-instruct",
  },
  openai: {
    chat:   "gpt-4o-mini",
    embed:  "text-embedding-3-small",
    heavy:  "gpt-4o",
    safety: "gpt-4o",
  },
  cohere: {
    chat:   "command-r-plus",
    embed:  "embed-english-v3.0",
    heavy:  "command-r-plus",
    safety: "command-r-plus",
  },
  anthropic: {
    chat:   "claude-3-5-sonnet-20241022",
    embed:  "",
    heavy:  "claude-3-5-sonnet-20241022",
    safety: "claude-3-5-sonnet-20241022",
  },
};

/**
 * Resolve the best provider for a given task and user.
 * Returns BYOK key if user has connected a preferred provider, else inbuilt.
 */
export async function resolveProvider(userId: string, task: Task): Promise<ResolvedProvider> {
  // Get all active BYOK keys for this user
  const userKeys = await db
    .select()
    .from(byokKeys)
    .where(and(eq(byokKeys.userId, userId), eq(byokKeys.active, true)));

  // Walk the preference list — first match wins
  for (const preferred of BYOK_PREFERENCE[task]) {
    const key = userKeys.find(k => k.provider === preferred);
    if (key) {
      return {
        source: "byok",
        provider: key.provider,
        apiKey: decryptKey(key.encryptedKey),
        baseURL: key.baseUrl ?? PROVIDER_BASE[key.provider],
        model: key.model ?? PROVIDER_DEFAULT_MODEL[key.provider]?.[task] ?? INBUILT_DEFAULTS[task].model,
      };
    }
  }

  // No BYOK match → use inbuilt
  return INBUILT_DEFAULTS[task];
}

/**
 * Run a chat completion using the resolved provider for the task.
 * Auto-falls back to inbuilt Groq on any error.
 */
export async function callLLM(
  userId: string,
  task: Task,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean } = {}
): Promise<{ text: string; usedProvider: string; usedModel: string; fellBack: boolean }> {
  const { temperature = 0.4, maxTokens = 1024 } = opts;
  const primary = await resolveProvider(userId, task);

  const run = async (p: ResolvedProvider): Promise<string> => {
    if (p.provider === "groq") {
      const groq = new Groq({ apiKey: p.apiKey });
      const r = await groq.chat.completions.create({
        messages, model: p.model, temperature, max_tokens: maxTokens,
        ...(opts.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      });
      return r.choices[0]?.message?.content ?? "";
    }
    if (p.provider === "anthropic") {
      // Anthropic SDK not wired — fall back
      throw new Error("Anthropic provider not implemented in router yet");
    }
    // OpenAI-compatible: NVIDIA, OpenAI, Cohere (compatibility), custom
    const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
    const r = await client.chat.completions.create({
      messages, model: p.model, temperature, max_tokens: maxTokens,
    });
    return r.choices[0]?.message?.content ?? "";
  };

  try {
    const text = await run(primary);
    return { text, usedProvider: primary.provider, usedModel: primary.model, fellBack: false };
  } catch (err) {
    console.error(`[router] ${task} failed on ${primary.provider}:`, err instanceof Error ? err.message : err);
    // Fall back to inbuilt Groq
    const fallback = INBUILT_DEFAULTS.chat;
    const text = await run(fallback);
    return { text, usedProvider: fallback.provider, usedModel: fallback.model, fellBack: true };
  }
}

/**
 * Get embedding for text using Cohere (or fallback OpenAI).
 */
export async function callEmbed(userId: string, text: string): Promise<number[]> {
  const p = await resolveProvider(userId, "embed");
  if (p.provider === "cohere") {
    const res = await fetch(`${p.baseURL}/embed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        texts: [text.slice(0, 8000)],
        model: p.model,
        input_type: "search_document",
      }),
    });
    const data = await res.json() as { embeddings?: number[][] };
    return data.embeddings?.[0] ?? [];
  }
  // OpenAI fallback
  const client = new OpenAI({ apiKey: p.apiKey, baseURL: p.baseURL });
  const r = await client.embeddings.create({ model: p.model, input: text.slice(0, 8000) });
  return r.data[0]?.embedding ?? [];
}
