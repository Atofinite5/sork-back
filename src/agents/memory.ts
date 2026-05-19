import { db } from "../db/index.js";
import { agentMemory } from "../db/schema.js";
import { eq, desc } from "drizzle-orm";
import { embedDocuments, embedQuery, cosineSimilarity } from "../lib/providers/cohere.js";

export interface MemoryEntry {
  role: string;
  content: string;
  embedding?: number[];
}

export async function saveMemory(userId: string, sessionId: string, role: string, content: string): Promise<void> {
  let embedding: string | undefined;
  try {
    const [vec] = await embedDocuments([content]);
    if (vec && vec.length > 0) {
      embedding = JSON.stringify(vec);
    }
  } catch {
    // embeddings are best-effort
  }

  await db.insert(agentMemory).values({ userId, sessionId, role, content, embedding });
}

export async function getRecentMemory(userId: string, sessionId: string, limit = 10): Promise<MemoryEntry[]> {
  const rows = await db
    .select({ role: agentMemory.role, content: agentMemory.content, embedding: agentMemory.embedding })
    .from(agentMemory)
    .where(eq(agentMemory.userId, userId))
    .orderBy(desc(agentMemory.createdAt))
    .limit(limit);

  return rows.reverse().map((r) => ({
    role: r.role,
    content: r.content,
    embedding: r.embedding ? (JSON.parse(r.embedding) as number[]) : undefined,
  }));
}

export async function searchMemory(userId: string, query: string, topK = 3): Promise<MemoryEntry[]> {
  try {
    const queryVec = await embedQuery(query);
    if (!queryVec?.length) return [];

    const rows = await db
      .select({ role: agentMemory.role, content: agentMemory.content, embedding: agentMemory.embedding })
      .from(agentMemory)
      .where(eq(agentMemory.userId, userId))
      .orderBy(desc(agentMemory.createdAt))
      .limit(100);

    const scored = rows
      .filter((r) => r.embedding)
      .map((r) => ({
        role: r.role,
        content: r.content,
        score: cosineSimilarity(queryVec, JSON.parse(r.embedding!) as number[]),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  } catch {
    return [];
  }
}
