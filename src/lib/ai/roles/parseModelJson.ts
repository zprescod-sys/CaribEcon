/* Shared by every role that asks a model for structured JSON (interpret, synthesize, and
 * whichever roles follow). Extracted rather than duplicated per-role: this is real parsing
 * logic, not a few similar lines, and two copies would be exactly the kind of thing that drifts
 * out of sync — the same "map before you build" reasoning ARCHITECTURE.md §2.5 applies to types
 * applies here to behaviour.
 *
 * Models reliably comply with "JSON only" most of the time but not always — a markdown fence or
 * a one-line preamble despite the instruction is common enough to defend against cheaply rather
 * than let it become a hard failure. Tries, in order: the raw trimmed text; the same text with a
 * ```/```json fence stripped; the largest {...} substring found anywhere in it.
 */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenceStripped = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const braceMatch = text.match(/\{[\s\S]*\}/);

  for (const attempt of [trimmed, fenceStripped, braceMatch?.[0]]) {
    if (!attempt) continue;
    try {
      return JSON.parse(attempt);
    } catch {
      continue;
    }
  }
  return null;
}
