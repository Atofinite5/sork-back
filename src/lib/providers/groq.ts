import Groq from "groq-sdk";

let client: Groq | null = null;

function getClient(): Groq {
  if (!client) {
    client = new Groq({ apiKey: process.env.GROQ_API_KEY! });
  }
  return client;
}

export interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function groqChat(
  messages: GroqMessage[],
  model = "llama-3.3-70b-versatile",
  temperature = 0.3,
  maxTokens = 2048
): Promise<string> {
  const groq = getClient();
  const completion = await groq.chat.completions.create({
    messages,
    model,
    temperature,
    max_tokens: maxTokens,
  });
  return completion.choices[0]?.message?.content ?? "";
}
