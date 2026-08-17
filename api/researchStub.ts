/* The CaribEcon Research Service running directly ON Vercel — Phase 0b, stub only.
 *
 * This calls the same `research()` the NoInfra MCP adapter calls
 * (research-service/src/mcpServer.mjs). Not a copy and not a port: the identical file, imported
 * by two different runtime adapters. That is §5.3 rule 1 — "the service is a plain async
 * function with no runtime-specific imports, and one thin adapter per runtime" — demonstrated
 * rather than asserted.
 *
 * WHY THIS EXISTS ALONGSIDE api/noinfraSpike.ts
 *
 * Phase 0b established that NoInfra cannot currently serve this role (docs/NOINFRA_SPIKE.md
 * §6b): MCP tools added by hot-reload never enter the gateway's startup-built HTTP tool
 * registry, and the gateway cannot be restarted from inside its own container.
 * api/noinfraSpike.ts is kept as the record of that path — still correct, still ready if an
 * external restart ever makes the gateway serve it.
 *
 * Note what does NOT change by moving the runtime here: Nebius, MiniMax and Impala were never
 * hosted by us on either runtime (§5.2 — inference is "never self-hosted"). They stay hosted
 * APIs reached over HTTPS; only the machine placing the call differs.
 *
 * PHASE 1 fills in the real pipeline behind this same seam — interpret, plan, execute, evidence,
 * synthesize, verify — at which point this becomes api/ask.ts. It is deliberately NOT named that
 * yet: /api/ask is the documented name for the real bounded Ask path, and a stub answering to it
 * is exactly the sort of thing someone later mistakes for the real endpoint. */
import { CORS_HEADERS, checkToken, clientIp, rateLimited } from '../src/lib/apiGuard.js';
import { research, InvalidRequestError } from '../research-service/src/service.mjs';

const MAX_QUESTION_CHARS = 500;

/* The adapter names the runtime, never the service — the whole point of keeping this out of
   research(). The MCP adapter passes 'noinfra'; here it is 'vercel'. Same function, and the
   response is what proves which runtime answered. */
const RUNTIME = 'vercel';

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

    // Same client-facing cost gate as api/research.ts and api/noinfraSpike.ts.
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
    if (question.length > MAX_QUESTION_CHARS) {
      return json(
        { error: 'bad_request', message: `Question must be under ${MAX_QUESTION_CHARS} characters.` },
        400,
      );
    }

    const startedAt = Date.now();
    try {
      const result = await research({ question }, { runtime: RUNTIME });
      return json({ ok: true, result, elapsedMs: Date.now() - startedAt }, 200);
    } catch (error) {
      /* The service's own validation error is the caller's mistake, so 400. Anything else is
         ours and stays unelaborated to the client. */
      if (error instanceof InvalidRequestError) {
        return json({ error: 'bad_request', message: error.message }, 400);
      }
      return json({ error: 'service_error', message: 'The research service failed.' }, 500);
    }
  },
};
