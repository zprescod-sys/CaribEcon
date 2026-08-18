/* Shared by every role that asks a model for structured JSON (interpret, synthesize, and
 * whichever roles follow). Extracted rather than duplicated per-role: this is real parsing
 * logic, not a few similar lines, and two copies would be exactly the kind of thing that drifts
 * out of sync — the same "map before you build" reasoning ARCHITECTURE.md §2.5 applies to types
 * applies here to behaviour.
 *
 * Models reliably comply with "JSON only" most of the time but not always — a markdown fence or
 * a one-line preamble despite the instruction is common enough to defend against cheaply rather
 * than let it become a hard failure. Tries, in order: the raw trimmed text; the same text with a
 * ```/```json fence stripped; then each complete top-level {...} object, last first. The latter
 * deliberately handles a reasoning model that emits a valid but irrelevant JSON draft before its
 * final answer. A regex for the "largest" brace span is unsafe: it joins those two objects into
 * invalid JSON and is confused by braces inside JSON strings.
 */
function completeObjects(text: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceStripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const objects = completeObjects(text).reverse();

  for (const attempt of [trimmed, fenceStripped, ...objects]) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  return null;
}
