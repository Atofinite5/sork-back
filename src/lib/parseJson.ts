// Robustly extract and parse a JSON object from an LLM response
// Handles: markdown fences, leading text, trailing text
export function extractJson<T>(raw: string): T | null {
  // Strategy 1: direct parse (cleanest case)
  try {
    return JSON.parse(raw.trim()) as T; // sork-ignore — guarded by try/catch
  } catch { /* continue */ }

  // Strategy 2: strip markdown fences
  const stripped = raw
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/\s*```\s*$/im, "")
    .trim();
  try {
    return JSON.parse(stripped) as T; // sork-ignore — guarded by try/catch
  } catch { /* continue */ }

  // Strategy 3: find first balanced { } or [ ] block
  const firstBrace   = stripped.indexOf("{");
  const firstBracket = stripped.indexOf("[");
  let start = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
  } else if (firstBracket !== -1) {
    start = firstBracket;
  }

  if (start !== -1) {
    const candidate = stripped.slice(start);
    const open  = candidate[0];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let end   = -1;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === open)  depth++;
      else if (candidate[i] === close) {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end !== -1) {
      try {
        return JSON.parse(candidate.slice(0, end)) as T; // sork-ignore — guarded by try/catch
      } catch { /* continue */ }
    }
  }

  return null;
}
