import { checkContentSafety } from "../lib/providers/nemotron.js";
import { triageAgent } from "./triage.js";
import { fixAgent } from "./fix.js";
import { verifyAgent } from "./verify.js";
import { saveMemory } from "./memory.js";

export interface OrchestratorInput {
  userId: string;
  sessionId: string;
  code: string;
  context?: string;
  byokApiKey?: string;
  byokBaseUrl?: string;
  byokModel?: string;
}

export interface OrchestratorResult {
  blocked: boolean;
  blockReason?: string;
  triage?: Awaited<ReturnType<typeof triageAgent>>;
  fix?: Awaited<ReturnType<typeof fixAgent>>;
  verify?: Awaited<ReturnType<typeof verifyAgent>>;
  pipeline: Array<{ agent: string; status: "ok" | "skipped" | "error"; duration: number }>;
}

export async function runPipeline(input: OrchestratorInput): Promise<OrchestratorResult> {
  const pipeline: OrchestratorResult["pipeline"] = [];

  // Step 0: Nemotron safety gate
  const safetyStart = Date.now();
  const safety = await checkContentSafety(input.code);
  pipeline.push({ agent: "safety-gate", status: "ok", duration: Date.now() - safetyStart });

  if (!safety.safe) {
    return {
      blocked: true,
      blockReason: safety.reason ?? "Content safety check failed.",
      pipeline,
    };
  }

  // Step 1: Triage Agent
  const triageStart = Date.now();
  const triage = await triageAgent(input.userId, input.code, input.context);
  pipeline.push({ agent: "triage", status: "ok", duration: Date.now() - triageStart });

  await saveMemory(input.userId, input.sessionId, "assistant", `Triage: ${triage.summary}`);

  // Step 2: Fix Agent (only if issues found)
  const fixStart = Date.now();
  const fix = await fixAgent(input.code, triage);
  pipeline.push({
    agent: "fix",
    status: triage.shouldFix ? "ok" : "skipped",
    duration: Date.now() - fixStart,
  });

  if (triage.shouldFix) {
    await saveMemory(input.userId, input.sessionId, "assistant", `Fix: ${fix.explanation}`);
  }

  // Step 3: Verify Agent
  const verifyStart = Date.now();
  const verify = await verifyAgent(input.code, fix, triage);
  pipeline.push({ agent: "verify", status: "ok", duration: Date.now() - verifyStart });

  await saveMemory(input.userId, input.sessionId, "assistant", `Verify: ${verify.notes}`);

  return { blocked: false, triage, fix, verify, pipeline };
}
