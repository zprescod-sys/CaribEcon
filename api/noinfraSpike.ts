/* Phase 0b connectivity spike — Vercel -> OpenClaw /tools/invoke -> caribecon-research agent
   -> MCP tool -> research-service stub -> structured JSON, and back.

   This endpoint exists to prove the invocation spine and nothing else. It is NOT /api/ask, it
   is not the research pipeline, and it is deliberately named so nobody mistakes it for either.
   api/research.ts stays frozen and untouched (CLAUDE.md); this path lives beside it.

   THE SECURITY SHAPE, which is the whole reason this file is narrow:

   The OpenClaw gateway bearer token is, in OpenClaw's own words, "effectively all-or-nothing
   operator access" — a caller holding it can target agentId "main" and reach every tool not on
   the gateway's HTTP deny list. So the token must never leave the server, and this route must
   never become a general-purpose OpenClaw proxy. Concretely:

     - agentId is a hardcoded constant, never a request field. Routing to the restricted agent
       is a property of this code, not a thing a caller asks for.
     - The tool name, gateway URL and gateway token are read from server env only.
     - The ONLY thing taken from the client is `question`, a string. Any other body field is
       ignored rather than forwarded — an allowlist, not a filter.
     - Nothing from the gateway response is echoed verbatim; the reply is re-shaped here, so a
       gateway error string can never carry internals back to a browser.

   Enabling /v1/chat/completions on the gateway would defeat all of the above (any token holder
   could then drive the full agent), so it stays disabled — see docs/NOINFRA_SPIKE.md. */
import { CORS_HEADERS, checkToken, clientIp, rateLimited } from '../src/lib/apiGuard.js';

/* Hardcoded, not configurable: the restricted agent is the point. Its OpenClaw config pins
   tools.profile "minimal" + tools.allow to just the CaribEcon tool, so a bug in this file
   cannot reach another tool even if it tried. */
const AGENT_ID = 'caribecon-research';

/* OpenClaw namespaces MCP tools by their `mcp.servers` config key, so the exposed name is
   expected to be "caribecon-research__caribecon_research". That prefix is the gateway's to
   assign — it is configurable here precisely because the first live invoke is what confirms it,
   and a wrong guess should be a config change rather than a redeploy. */
const TOOL_NAME = process.env.OPENCLAW_CARIBECON_TOOL || 'caribecon-research__caribecon_research';

const MAX_QUESTION_CHARS = 500;

/* Shorter than this function's maxDuration (30s in vercel.json) and shorter than OpenClaw's
   documented 30s RPC timeout, so we fail first and can say something honest about it rather
   than being cut off mid-flight by the platform. Configurable because §7's budget numbers are
   reasoned guesses until this spike measures the real round trip — tuning that should not need
   a redeploy. Read per-request, not at module scope: a Fluid Compute instance is reused across
   invocations, so a module-scope read would pin the first value seen for the instance's life. */
const DEFAULT_GATEWAY_TIMEOUT_MS = 25_000;
const gatewayTimeoutMs = () =>
  Number(process.env.OPENCLAW_GATEWAY_TIMEOUT_MS) || DEFAULT_GATEWAY_TIMEOUT_MS;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/* The gateway wraps the MCP result, and the MCP result itself carries the payload twice
   (structuredContent + a JSON text block). Which of those survives the gateway hop is exactly
   what this spike is measuring, so unwrap defensively and report what was found rather than
   assuming one shape and 500ing on the other. */
function unwrap(payload: unknown): unknown {
  const seen = new Set<unknown>();
  let node: unknown = payload;

  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node);
    const record = node as Record<string, unknown>;

    if (record.structuredContent !== undefined) return record.structuredContent;

    if (Array.isArray(record.content)) {
      const text = record.content.find(
        (block): block is { type: string; text: string } =>
          !!block && typeof block === 'object' && (block as { type?: string }).type === 'text',
      );
      if (text) {
        try {
          return JSON.parse(text.text);
        } catch {
          return text.text;
        }
      }
    }

    if (record.result !== undefined) {
      node = record.result;
      continue;
    }
    break;
  }

  return node;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    // Same client-facing cost gate as api/research.ts — see src/lib/apiGuard.ts.
    const auth = checkToken(request);
    if (!auth.ok) {
      return json({ error: auth.error, message: auth.message }, auth.status);
    }
    if (rateLimited(clientIp(request))) {
      return json({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' }, 429);
    }

    /* Fail closed on missing CONFIGURATION — distinct from degrading on a runtime failure
       (ARCHITECTURE.md §1, item 5). An unset gateway URL or token is a deployment mistake, so
       it is a 503 at request start, not a silent local fallback. */
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    if (!gatewayUrl || !gatewayToken) {
      return json(
        {
          error: 'not_configured',
          message: 'OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN must be set on the server.',
        },
        503,
      );
    }

    let question: string;
    try {
      const body = (await request.json()) as { question?: unknown };
      question = String(body.question ?? '').trim();
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }
    if (!question) {
      return json({ error: 'bad_request', message: 'A "question" is required.' }, 400);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return json(
        { error: 'bad_request', message: `Question must be under ${MAX_QUESTION_CHARS} characters.` },
        400,
      );
    }

    const startedAt = Date.now();
    const timeoutMs = gatewayTimeoutMs();
    const abort = AbortSignal.timeout(timeoutMs);

    let response: Response;
    try {
      response = await fetch(new URL('/tools/invoke', gatewayUrl), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          'Content-Type': 'application/json',
        },
        /* The entire request body, assembled here. `question` is the only value that came from
           the caller; agentId and tool are ours. */
        body: JSON.stringify({ agentId: AGENT_ID, tool: TOOL_NAME, args: { question } }),
        signal: abort,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return json(
        {
          error: timedOut ? 'gateway_timeout' : 'gateway_unreachable',
          message: timedOut
            ? `No response from the research runtime within ${timeoutMs}ms.`
            : 'Could not reach the research runtime.',
          elapsedMs: Date.now() - startedAt,
        },
        timedOut ? 504 : 502,
      );
    }

    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* Truncated, and only ever on a non-JSON body — a gateway that returns HTML (a proxy
         error page, say) is a finding worth seeing during the spike, but it is not something to
         relay at full length. */
      return json(
        {
          error: 'gateway_bad_response',
          message: 'The research runtime did not return JSON.',
          status: response.status,
          bodyPreview: raw.slice(0, 200),
        },
        502,
      );
    }

    if (!response.ok) {
      return json(
        {
          error: 'gateway_error',
          message: `The research runtime returned ${response.status}.`,
          status: response.status,
        },
        502,
      );
    }

    return json(
      {
        ok: true,
        agentId: AGENT_ID,
        tool: TOOL_NAME,
        result: unwrap(payload),
        elapsedMs: Date.now() - startedAt,
      },
      200,
    );
  },
};
