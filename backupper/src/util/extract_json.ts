/**
 * Robust JSON-object extraction from noisy LLM output.
 *
 * LLM/CLI output is narration-heavy: markdown fences, prose, and often
 * several JSON-ish blocks (e.g. an echoed proposal followed by the real
 * verdict). The old approach — `raw.match(/\{[\s\S]*\}/)` — spans from the
 * FIRST `{` to the LAST `}`, which merges multiple objects into one
 * un-parseable blob (or silently grabs the wrong one). This walks brace
 * depth while respecting string literals, returning each balanced
 * top-level `{...}` object that parses, in source order.
 */
export function extractJsonObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  if (!raw) return out;
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            out.push(JSON.parse(raw.slice(start, i + 1)));
          } catch {
            /* not valid JSON — skip this block */
          }
          start = -1;
        }
      }
    }
  }
  return out;
}

/**
 * The LAST extracted object satisfying `pred` (the final verdict usually
 * comes after any echoed proposal), else null.
 */
export function extractJsonObject<T = unknown>(
  raw: string,
  pred: (o: unknown) => boolean,
): T | null {
  const objs = extractJsonObjects(raw);
  for (let i = objs.length - 1; i >= 0; i--) {
    if (pred(objs[i])) return objs[i] as T;
  }
  return null;
}
