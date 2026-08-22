/* The real Ask CaribEcon path — CLAUDE.md's planned `POST /api/ask`, ARCHITECTURE.md §5.2's
 * "new bounded Ask path: shared provider roles, deterministic evidence, and deterministic
 * citations." This is the endpoint api/researchStub.ts's own header named in advance: "PHASE 1
 * fills in the real pipeline behind this same seam... at which point this becomes api/ask.ts."
 *
 * api/researchStub.ts and research-service/ are deliberately left untouched by this file — they
 * remain the Phase 0b NoInfra/Vercel portability record (BUILD_PLAN.md), not something this step
 * retires. This endpoint calls a different, real research() — src/lib/ai/research.ts, the
 * interpret -> plan -> validateResearchPlan -> executeResearchPlan -> synthesize composition —
 * not the Phase 0b stub.
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
import { PlanNotConfiguredError, PlanParseError } from '../src/lib/ai/roles/plan.js';
import { SynthesizeNotConfiguredError, SynthesizeParseError } from '../src/lib/ai/roles/synthesize.js';
import { StagedProviderFailure } from '../src/lib/ai/providerFailure.js';
import { MAX_HISTORY_TURNS, MAX_REHYDRATED_REFS } from '../src/lib/ai/config.js';
import type { ConversationTurn, EvidenceRef } from '../src/lib/ai/contracts.js';

/* finishReason/completionTokens are the diagnostic pair that tells apart the two very different
   ways a role can fail to produce parseable JSON: 'length' means the completion was cut off
   before the model ever finished its <think> trace (see openaiCompatible.ts's stripThinking) —
   the fix is a bigger maxTokens ceiling. 'stop' means the model finished normally and still
   didn't produce valid JSON — a prompt/compliance problem, not a budget one. Neither value is raw
   model text, so both are safe to log (and to keep server-side alongside rawLength, never in the
   client response, per this function's existing discipline). */
function structuredOutputFailure(
  error: unknown,
): { stage: 'interpretation' | 'planning' | 'answer'; rawLength: number; finishReason: string | null; completionTokens: number | null } | null {
  if (error instanceof InterpretParseError)
    return { stage: 'interpretation', rawLength: error.rawText.length, finishReason: error.finishReason, completionTokens: error.completionTokens };
  if (error instanceof PlanParseError)
    return { stage: 'planning', rawLength: error.rawText.length, finishReason: error.finishReason, completionTokens: error.completionTokens };
  if (error instanceof SynthesizeParseError)
    return { stage: 'answer', rawLength: error.rawText.length, finishReason: error.finishReason, completionTokens: error.completionTokens };
  return null;
}

const MAX_QUESTION_CHARS = 500;

/* The trust boundary for ConversationTurn (ARCHITECTURE.md §2.7, §2.4 C3) — the ONE place raw
 * client JSON becomes the sanitized shape research()/interpret() are allowed to trust, exactly
 * the same discipline `question` itself already gets a few lines below. Malformed input degrades
 * (a bad entry is dropped, never a 400) — history is optional enrichment, not a hard dependency,
 * the same fail-soft precedent this pipeline already applies everywhere else optional context can
 * go missing. Never throws.
 *
 * Security-critical: only "D:" / "N:" refs survive. A "W:" ref is dropped unconditionally — web
 * evidence is turn-local and must NEVER be accepted back from a client, because the browser is an
 * untrusted boundary that could echo back a fabricated "here is what that page said" while keeping
 * the schema valid, and the grounding gate would then verify a fabricated quote against fabricated
 * evidence. This is not a length limit or a format nicety; it is the one rule in this function that
 * may never be relaxed. */
function sanitizeHistory(raw: unknown): ConversationTurn[] {
  if (!Array.isArray(raw)) return [];

  const turns: ConversationTurn[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;

    const question = typeof e.question === 'string' ? e.question.trim().slice(0, MAX_QUESTION_CHARS) : '';
    if (!question) continue; // a turn with no question text carries nothing usable — drop it

    const headline = typeof e.headline === 'string' ? e.headline.trim().slice(0, MAX_QUESTION_CHARS) : '';
    const rawRefs = Array.isArray(e.refs) ? e.refs : [];
    const refs = rawRefs.filter(
      (r): r is EvidenceRef => typeof r === 'string' && (r.startsWith('D:') || r.startsWith('N:')),
    );
    turns.push({ question, headline, refs });
  }

  // Most recent MAX_HISTORY_TURNS only — oldest turns beyond the window are simply forgotten.
  const clamped = turns.slice(-MAX_HISTORY_TURNS);

  // Aggregate ref cap: trim from the OLDEST turns first, since a stale early ref is the least
  // useful context to a follow-up question — the newest turn's refs are what "their"/"that"
  // almost always resolves to.
  let totalRefs = clamped.reduce((sum, t) => sum + t.refs.length, 0);
  for (let i = 0; i < clamped.length && totalRefs > MAX_REHYDRATED_REFS; i++) {
    const drop = Math.min(totalRefs - MAX_REHYDRATED_REFS, clamped[i].refs.length);
    if (drop > 0) {
      clamped[i] = { ...clamped[i], refs: clamped[i].refs.slice(drop) };
      totalRefs -= drop;
    }
  }
  return clamped;
}

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
    let history: ConversationTurn[];
    try {
      const body = (await request.json()) as { question?: unknown; history?: unknown };
      question = String(body.question ?? '').trim();
      history = sanitizeHistory(body.history);
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
    const requestId = crypto.randomUUID();
    try {
      const result = await research({ question, history }, { signal: request.signal });
      return json({ ok: true, result, elapsedMs: Date.now() - startedAt }, 200);
    } catch (error) {
      if (request.signal.aborted) {
        // The signal also aborts all outbound provider and evidence fetches, preventing a later
        // pipeline stage from starting after the user selected Stop.
        return json({ error: 'request_cancelled' }, 499);
      }
      /* Missing role configuration is the server's own fail-closed rule (config.ts) surfacing
         at request time, so 503 — same status apiGuard's own checkToken uses for the same
         reason. A model that returned unparseable output is an upstream failure, not the
         caller's mistake and not our bug, so 502 — and the raw model text stays server-side,
         never in the response (ARCHITECTURE.md §2.4: model deliberation is never shown). */
      if (
        error instanceof InterpretNotConfiguredError ||
        error instanceof PlanNotConfiguredError ||
        error instanceof SynthesizeNotConfiguredError
      ) {
        console.warn('api/ask: provider configuration failure', { requestId });
        return json(
          {
            error: 'not_configured',
            message: 'An AI service required for this request is not configured correctly.',
            retryable: false,
            requestId,
          },
          503,
        );
      }
      const structuredFailure = structuredOutputFailure(error);
      if (structuredFailure) {
        // Keep raw model text server-side — it can contain reasoning or prompt-derived material.
        // Stage, length, finishReason, and completionTokens are sufficient to diagnose malformed
        // output (and to tell truncation apart from a model that simply ignored the JSON
        // instruction) without recording the text itself.
        console.warn('api/ask: structured-output failure', { requestId, ...structuredFailure });
        return json(
          {
            error: 'model_error',
            stage: structuredFailure.stage,
            message: `The research ${structuredFailure.stage} model returned an invalid structured response. Please try again.`,
            retryable: true,
            requestId,
          },
          502,
        );
      }
      if (error instanceof StagedProviderFailure) {
        const { failure } = error;
        // Do not log provider text, prompts, headers, or keys. These stable fields make route
        // faults diagnosable without making model/provider internals part of the public contract.
        console.warn('api/ask: provider failure', {
          requestId,
          stage: failure.stage,
          provider: failure.provider,
          model: failure.model,
          endpoint: failure.endpoint,
          providerStatus: failure.providerStatus,
          code: failure.code,
          retryable: failure.retryable,
          elapsedMs: Date.now() - startedAt,
        });
        return json(
          {
            error: failure.code,
            stage: failure.stage,
            message: failure.message,
            retryable: failure.retryable,
            requestId,
          },
          failure.code === 'provider_timeout'
            ? 504
            : failure.code === 'provider_server_error' ||
                failure.code === 'provider_invalid_response' ||
                failure.code === 'provider_bad_request'
              ? 502
              : 503,
        );
      }
      console.error('api/ask: unexpected pipeline error', error);
      return json({ error: 'service_error', message: 'The research service failed.', retryable: false, requestId }, 500);
    }
  },
};
