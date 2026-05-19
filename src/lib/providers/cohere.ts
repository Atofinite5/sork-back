import { CohereClient } from "cohere-ai";

let client: CohereClient | null = null;

function getClient(): CohereClient {
  if (!client) {
    client = new CohereClient({ token: process.env.COHERE_API_KEY! });
  }
  return client;
}

// input_type: "search_document" for storing, "search_query" for querying
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const cohere = getClient();
  const response = await cohere.embed({
    texts,
    model: "embed-english-v3.0",
    inputType: "search_document",
    truncate: "END",
  });
  return (response.embeddings as number[][]) ?? texts.map(() => []);
}

export async function embedQuery(text: string): Promise<number[]> {
  const cohere = getClient();
  const response = await cohere.embed({
    texts: [text],
    model: "embed-english-v3.0",
    inputType: "search_query",
    truncate: "END",
  });
  return ((response.embeddings as number[][])?.[0]) ?? [];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  const dot = a.reduce((sum, val, i) => sum + val * (b[i] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}
