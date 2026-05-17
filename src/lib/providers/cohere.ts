import { CohereClient } from "cohere-ai";

let client: CohereClient | null = null;

function getClient(): CohereClient {
  if (!client) {
    client = new CohereClient({ token: process.env.COHERE_API_KEY! });
  }
  return client;
}

export async function embedText(texts: string[]): Promise<number[][]> {
  const cohere = getClient();
  const response = await cohere.embed({
    texts,
    model: "embed-english-v3.0",
    inputType: "search_document",
  });

  if (response.embeddings && Array.isArray(response.embeddings)) {
    return response.embeddings as number[][];
  }
  return texts.map(() => []);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}
