/* The CaribEcon Research Service — PHASE 0b STUB.
 *
 * This is deliberately not the research pipeline. Its only job is to be the far end of the
 * invocation spine we are proving:
 *
 *   test client / Vercel -> OpenClaw /tools/invoke -> caribecon-research agent
 *     -> MCP tool -> THIS FUNCTION -> structured JSON back
 *
 * Everything real — Nebius/MiniMax/Impala, Tavily, the Data Hub and News Hub readers, the
 * calculation registry, EvidencePackage, the grounding gate, the claims audit — is explicitly
 * out of scope here and lands in later phases (docs/ARCHITECTURE.md §7).
 *
 * The seam matters more than the body. Per the portability rules (ARCHITECTURE.md §5.3 rule 1)
 * this is a plain async function with NO runtime-specific imports: no MCP types, no HTTP types,
 * no process.env, no filesystem. The MCP server beside it is one thin adapter over this; a
 * Vercel handler would be another. When the real research() lands it replaces this body, and
 * every adapter around it keeps working unchanged.
 */

/* Kept as a parameter rather than read from process.env for the same reason: a service that
   reads its own environment knows which runtime it is in, and then it is no longer portable.
   The adapter passes this in — see mcpServer.mjs. */
export const DEFAULT_RUNTIME = 'noinfra';

export class InvalidRequestError extends Error {}

/* Validates the request the same way the real service will have to, so the spine we prove is
   the spine we keep. A missing question is a caller bug and must not silently succeed —
   otherwise a green end-to-end ping would prove the pipe carries nothing. */
export async function research(request = {}, { runtime = DEFAULT_RUNTIME } = {}) {
  const question = typeof request.question === 'string' ? request.question.trim() : '';
  if (!question) {
    throw new InvalidRequestError('A non-empty "question" string is required.');
  }

  /* Phase 0b returns a fixed structured result. It carries no figures, no citations and no
     prose precisely because nothing here retrieved anything — per ARCHITECTURE.md §2.1, no
     model and no stub may produce what the deterministic core has not. */
  return {
    ok: true,
    service: 'caribecon-research',
    runtime,
  };
}
