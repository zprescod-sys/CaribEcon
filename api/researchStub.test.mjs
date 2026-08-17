/* Tests for the Vercel-hosted Research Service stub (api/researchStub.ts).
 *
 * The load-bearing test here is the portability one: the SAME research() that
 * research-service/src/mcpServer.test.mjs drives over MCP stdio also answers an HTTP request,
 * and reports a different runtime purely because the adapter told it to. That is §5.3 rule 1
 * checked rather than claimed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import stub from './researchStub.ts';

const TOKEN = 'test-client-token';

let callerCount = 0;
const post = (body, headers = { 'X-CaribEcon-Token': TOKEN }) =>
  stub.fetch(
    new Request('http://localhost/api/researchStub', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // apiGuard's rate limiter is module-level and shared across endpoints — distinct IPs
        // keep this suite from exhausting the 12/min budget partway through.
        'x-forwarded-for': `198.51.100.${++callerCount % 250}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

async function withToken(run) {
  const saved = process.env.CARIBECON_RESEARCH_TOKEN;
  process.env.CARIBECON_RESEARCH_TOKEN = TOKEN;
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.CARIBECON_RESEARCH_TOKEN;
    else process.env.CARIBECON_RESEARCH_TOKEN = saved;
  }
}

test('the same service answers over HTTP, reporting the vercel runtime', async () => {
  await withToken(async () => {
    const res = await post({ question: 'ping' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.result, {
      ok: true,
      service: 'caribecon-research',
      // research-service/src/mcpServer.test.mjs asserts 'noinfra' for the identical function.
      // One service, two adapters, and only the adapter knows where it is running.
      runtime: 'vercel',
    });
    assert.equal(typeof body.elapsedMs, 'number');
  });
});

test('an empty question is a 400 from the service itself, not a 500', async () => {
  await withToken(async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ question: '   ' })).status, 400);
  });
});

test('a question over the length cap is rejected before the service runs', async () => {
  await withToken(async () => {
    assert.equal((await post({ question: 'x'.repeat(501) })).status, 400);
  });
});

test('fails closed with 503 when CARIBECON_RESEARCH_TOKEN is unset', async () => {
  const saved = process.env.CARIBECON_RESEARCH_TOKEN;
  delete process.env.CARIBECON_RESEARCH_TOKEN;
  try {
    const res = await post({ question: 'ping' });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'not_configured');
  } finally {
    if (saved !== undefined) process.env.CARIBECON_RESEARCH_TOKEN = saved;
  }
});

test('rejects a missing or wrong client token with 401', async () => {
  await withToken(async () => {
    assert.equal((await post({ question: 'ping' }, {})).status, 401);
    assert.equal((await post({ question: 'ping' }, { 'X-CaribEcon-Token': 'wrong' })).status, 401);
  });
});

test('rejects non-POST methods', async () => {
  const res = await stub.fetch(new Request('http://localhost/api/researchStub', { method: 'GET' }));
  assert.equal(res.status, 405);
});
