/* Tests for the Phase 0b spike proxy (api/noinfraSpike.ts).
 *
 * No mocks. Each test stands up a REAL local HTTP server standing in for the OpenClaw gateway
 * and points OPENCLAW_GATEWAY_URL at it, so the route performs a genuine fetch and we assert on
 * the request that actually arrived. That is deliberate: the load-bearing claims here are about
 * what this route SENDS (a hardcoded agentId, a server-side token, nothing caller-controlled
 * beyond `question`), and those are only meaningfully checkable by inspecting the wire.
 *
 * Consistent with the repo's no-provider-mocking policy (api/research.test.mjs header): nothing
 * here fakes a model or a research result. The stand-in gateway returns fixed envelopes purely
 * to exercise our own unwrapping and error mapping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import spike from './noinfraSpike.ts';

const TOKEN = 'test-client-token';

/* Starts a stand-in gateway. `respond` receives the parsed request body and returns
   { status, body } — or a string body, to exercise the non-JSON path. */
async function withGateway(respond, run) {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ url: req.url, method: req.method, headers: req.headers, body });
      const { status = 200, body: out = { ok: true, result: {} } } = respond(body) ?? {};
      const payload = typeof out === 'string' ? out : JSON.stringify(out);
      res.writeHead(status, { 'Content-Type': typeof out === 'string' ? 'text/html' : 'application/json' });
      res.end(payload);
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const saved = { ...process.env };
  process.env.CARIBECON_RESEARCH_TOKEN = TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = url;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-operator-secret';
  delete process.env.OPENCLAW_CARIBECON_TOOL;

  try {
    return await run(received);
  } finally {
    process.env = saved;
    await new Promise(resolve => server.close(resolve));
  }
}

/* Each request gets a distinct client IP. apiGuard's rate limiter is module-level state shared
   by every AI-spending endpoint, so without this the suite would exhaust the 12/minute budget
   partway through and later tests would fail with a 429 for reasons unrelated to what they
   assert. Distinct IPs are also what real callers have. */
let callerCount = 0;
const post = (body, headers = { 'X-CaribEcon-Token': TOKEN }) =>
  spike.fetch(
    new Request('http://localhost/api/noinfraSpike', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `203.0.113.${++callerCount % 250}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

const OK_ENVELOPE = {
  ok: true,
  result: {
    content: [{ type: 'text', text: JSON.stringify({ ok: true, service: 'caribecon-research', runtime: 'noinfra' }) }],
    structuredContent: { ok: true, service: 'caribecon-research', runtime: 'noinfra' },
  },
};

// ── The security shape ─────────────────────────────────────────────────────────────────────

test('sends the hardcoded restricted agentId and the configured tool — never the caller\'s', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async received => {
      await post({ question: 'ping' });
      assert.equal(received[0].body.agentId, 'caribecon-research');
      assert.equal(received[0].body.tool, 'caribecon-research__caribecon_research');
      assert.equal(received[0].url, '/tools/invoke');
    },
  );
});

test('a caller cannot override agentId, tool, or the gateway target', async () => {
  // The real attack this prevents: steering the request at agentId "main", which is NOT tool-
  // restricted, and so would reach every tool the gateway's HTTP deny list does not block.
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async received => {
      await post({
        question: 'ping',
        agentId: 'main',
        tool: 'exec',
        args: { command: 'echo pwned' },
        gatewayUrl: 'https://attacker.example',
      });

      const sent = received[0].body;
      assert.equal(sent.agentId, 'caribecon-research');
      assert.equal(sent.tool, 'caribecon-research__caribecon_research');
      // An allowlist, not a filter: only `question` survives into args.
      assert.deepEqual(sent.args, { question: 'ping' });
      assert.equal(sent.command, undefined);
    },
  );
});

test('the gateway token comes from server env and is never taken from the client', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async received => {
      await post(
        { question: 'ping' },
        { 'X-CaribEcon-Token': TOKEN, Authorization: 'Bearer attacker-supplied' },
      );
      assert.equal(received[0].headers.authorization, 'Bearer gateway-operator-secret');
    },
  );
});

test('the gateway token never appears in any response body', async () => {
  await withGateway(
    () => ({ status: 500, body: { ok: false, error: 'boom' } }),
    async () => {
      const res = await post({ question: 'ping' });
      assert.ok(!(await res.text()).includes('gateway-operator-secret'));
    },
  );
});

// ── The client-facing gate (shared with api/research.ts via apiGuard) ──────────────────────

test('fails closed with 503 when CARIBECON_RESEARCH_TOKEN is unset', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async () => {
      delete process.env.CARIBECON_RESEARCH_TOKEN;
      const res = await post({ question: 'ping' });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'not_configured');
    },
  );
});

test('rejects a missing or wrong client token with 401', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async () => {
      assert.equal((await post({ question: 'ping' }, {})).status, 401);
      assert.equal((await post({ question: 'ping' }, { 'X-CaribEcon-Token': 'wrong' })).status, 401);
    },
  );
});

test('fails closed with 503 when the gateway is not configured', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async () => {
      delete process.env.OPENCLAW_GATEWAY_URL;
      const res = await post({ question: 'ping' });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'not_configured');
    },
  );
});

test('requires a non-empty question under the length cap', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async received => {
      assert.equal((await post({})).status, 400);
      assert.equal((await post({ question: '   ' })).status, 400);
      assert.equal((await post({ question: 'x'.repeat(501) })).status, 400);
      assert.equal(received.length, 0, 'a rejected request must never reach the gateway');
    },
  );
});

// ── Unwrapping and failure mapping ─────────────────────────────────────────────────────────

test('unwraps the MCP envelope to the service result', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async () => {
      const body = await (await post({ question: 'ping' })).json();
      assert.deepEqual(body.result, { ok: true, service: 'caribecon-research', runtime: 'noinfra' });
      assert.equal(typeof body.elapsedMs, 'number');
    },
  );
});

test('unwraps a text-only envelope too — the gateway may drop structuredContent', async () => {
  await withGateway(
    () => ({
      body: {
        ok: true,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, service: 'caribecon-research', runtime: 'noinfra' }) }],
        },
      },
    }),
    async () => {
      const body = await (await post({ question: 'ping' })).json();
      assert.deepEqual(body.result, { ok: true, service: 'caribecon-research', runtime: 'noinfra' });
    },
  );
});

test('maps a gateway HTTP error to 502 without leaking its body', async () => {
  await withGateway(
    () => ({ status: 401, body: { ok: false, error: { message: 'invalid token' } } }),
    async () => {
      const res = await post({ question: 'ping' });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'gateway_error');
      assert.equal(body.status, 401);
      assert.ok(!JSON.stringify(body).includes('invalid token'));
    },
  );
});

test('maps a non-JSON gateway response to 502 with a truncated preview', async () => {
  await withGateway(
    () => ({ status: 502, body: `<html>${'x'.repeat(500)}</html>` }),
    async () => {
      const res = await post({ question: 'ping' });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, 'gateway_bad_response');
      assert.ok(body.bodyPreview.length <= 200);
    },
  );
});

test('a slow gateway is a 504 at the configured deadline, not a hang', async () => {
  // Phase 0b requires timeout behaviour to be understood rather than assumed (ARCHITECTURE.md
  // §7). Driven by a short OPENCLAW_GATEWAY_TIMEOUT_MS against a gateway that never replies, so
  // the real 25s default is exercised in milliseconds.
  const server = createServer(() => {
    /* deliberately never responds */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const saved = { ...process.env };
  process.env.CARIBECON_RESEARCH_TOKEN = TOKEN;
  process.env.OPENCLAW_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCLAW_GATEWAY_TOKEN = 'gateway-operator-secret';
  process.env.OPENCLAW_GATEWAY_TIMEOUT_MS = '250';

  try {
    const res = await post({ question: 'ping' });
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.error, 'gateway_timeout');
    assert.ok(body.message.includes('250ms'), 'the deadline must be stated honestly');
    assert.equal(typeof body.elapsedMs, 'number');
  } finally {
    process.env = saved;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('an unreachable gateway is a 502, not an unhandled throw', async () => {
  await withGateway(
    () => ({ body: OK_ENVELOPE }),
    async () => {
      // Port 1 on loopback: nothing listens, connection is refused immediately.
      process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:1';
      const res = await post({ question: 'ping' });
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error, 'gateway_unreachable');
    },
  );
});
