/* The real Ask CaribEcon path — CLAUDE.md's planned `POST /api/ask`, ARCHITECTURE.md §5.2's
 * "new bounded Ask path: shared provider roles, deterministic evidence, and deterministic
 * citations." This is the endpoint api/researchStub.ts's own header named in advance: "PHASE 1
 * fills in the real pipeline behind this same seam... at which point this becomes api/ask.ts."
 *
 * api/researchStub.ts and research-service/ are deliberately left untouched by this file — they
 * remain the Phase 0b NoInfra/Vercel portability record (BUILD_PLAN.md), not something this step
 * retires. This endpoint calls a different, real research() — src/lib/ai/research.ts, the
 * interpret -> buildEvidencePackage -> synthesize composition — not the Phase 0b stub.
 *
 * api/research.ts is frozen for the buildathon (CLAUDE.md "Active build"), so the auth/CORS/
 * rate-limit guard is imported from src/lib/apiGuard.ts (already extracted for exactly this
 * reason) rather than copied a second time.
 *
 * PHASE 1 SCOPE: the ResearchResult this returns carries a stubbed verdict (see research.ts's
 * own header) — outcome is always 'PASS' because Phase 2's grounding gate does not exist yet.
 * This endpoint does not claim otherwise; it is the caller's job (the task pane) to not present
 * the narrative as verified until Phase 2 ships.
 */
import { CORS_HEADERS, checkToken, clientIp, rateLimited } from '../src/lib/apiGuard.js';
import { research } from '../src/lib/ai/research.js';
import { InterpretNotConfiguredError, InterpretParseError } from '../src/lib/ai/roles/interpret.js';
import { SynthesizeNotConfiguredError, SynthesizeParseError } from '../src/lib/ai/roles/synthesize.js';

const MAX_QUESTION_CHARS = 500;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    // Same client-facing cost gate as api/research.ts and api/researchStub.ts.
    const auth = checkToken(request);
    if (!auth.ok) {
      return json({ error: auth.error, message: auth.message }, auth.status);
    }
    if (rateLimited(clientIp(request))) {
      return json({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, 429);
    }

    let question: string;
    try {
      const body = (await request.json()) as { question?: unknown };
      question = String(body.question ?? '').trim();
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }
    if (!question) {
      return json({ error: 'bad_request', message: 'A non-empty "question" string is required.' }, 400);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return json(
        { error: 'bad_request', message: `Question must be under ${MAX_QUESTION_CHARS} characters.` },
        400,
      );
    }

    const startedAt = Date.now();
    try {
      const result = await research({ question });
      return json({ ok: true, result, elapsedMs: Date.now() - startedAt }, 200);
    } catch (error) {
      /* Missing role configuration is the server's own fail-closed rule (config.ts) surfacing
         at request time, so 503 — same status apiGuard's own checkToken uses for the same
         reason. A model that returned unparseable output is an upstream failure, not the
         caller's mistake and not our bug, so 502 — and the raw model text stays server-side,
         never in the response (ARCHITECTURE.md §2.4: model deliberation is never shown). */
      if (error instanceof InterpretNotConfiguredError || error instanceof SynthesizeNotConfiguredError) {
        return json({ error: 'not_configured', message: error.message }, 503);
      }
      if (error instanceof InterpretParseError || error instanceof SynthesizeParseError) {
        return json(
          { error: 'model_error', message: 'The research pipeline could not produce a usable answer. Try rephrasing the question.' },
          502,
        );
      }
      return json({ error: 'service_error', message: 'The research service failed.' }, 500);
    }
  },
};
