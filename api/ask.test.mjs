/* Tests for api/ask.ts — the real Ask CaribEcon endpoint (interpret -> evidence -> synthesize,
 * wrapped as the canonical ResearchResult).
 *
 * No mocks — same standing policy as api/research.test.mjs and src/lib/ai/research.test.mjs.
 * Two real local HTTP servers stand in for the interpret and synthesis roles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ask from './ask.ts';

const TOKEN = 'test-client-token';

let callerCount = 0;
const post = (body, headers = { 'X-CaribEcon-Token': TOKEN }) =>
  ask.fetch(
    new Request('http://localhost/api/ask', {
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

/* async, and awaits `run()` before restoring — see src/lib/ai/research.test.mjs's withEnv for
   why a synchronous finally is wrong here: this endpoint composes two sequential awaited role
   calls, and synthesize()'s config read happens after interpret()'s first await. */
async function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonServer(respond) {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const text = respond(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    });
  });
}

const INTERPRET_OK = () =>
  JSON.stringify({
    questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'],
    yearFrom: null, yearTo: null, newsKeywords: [],
  });
const SYNTHESIZE_OK = () =>
  JSON.stringify({ headline: 'Guyana GDP growth', claims: [], gaps: [] });

async function withRoleProviders({ interpretRespond = INTERPRET_OK, synthesisRespond = SYNTHESIZE_OK }, run) {
  const interpretServer = jsonServer(interpretRespond);
  const synthesisServer = jsonServer(synthesisRespond);
  await Promise.all([
    new Promise(resolve => interpretServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => synthesisServer.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    await withEnv(
      {
        CARIBECON_RESEARCH_TOKEN: TOKEN,
        CARIBECON_INTERPRET_PROVIDER: 'nebius',
        CARIBECON_INTERPRET_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${interpretServer.address().port}`,
        NEBIUS_API_KEY: 'test-key',
        CARIBECON_SYNTHESIS_PROVIDER: 'minimax',
        CARIBECON_SYNTHESIS_MODEL: 'test-model',
        MINIMAX_BASE_URL: `http://127.0.0.1:${synthesisServer.address().port}`,
        MINIMAX_API_KEY: 'test-key',
      },
      run,
    );
  } finally {
    await Promise.all([
      new Promise(resolve => interpretServer.close(resolve)),
      new Promise(resolve => synthesisServer.close(resolve)),
    ]);
  }
}

// ── Happy path ───────────────────────────────────────────────────────────────────────────────

test('returns a canonical ResearchResult with a stubbed PASS verdict', async () => {
  await withRoleProviders({}, async () => {
    const res = await post({ question: 'GDP growth in Guyana?' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.answer.headline, 'Guyana GDP growth');
    assert.equal(body.result.evidence.data[0].country, 'GY');
    assert.deepEqual(body.result.verdict, {
      outcome: 'PASS',
      grounding: { ran: true, violations: [] },
      audit: { ran: false },
      publishedClaims: [],
      reasonCategories: [],
    });
    assert.equal(typeof body.elapsedMs, 'number');
  });
});

// ── Request validation, before any role runs ────────────────────────────────────────────────

test('an empty question is a 400, not a wasted model call', async () => {
  await withRoleProviders({}, async () => {
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ question: '   ' })).status, 400);
  });
});

test('a question over the length cap is rejected before any role runs', async () => {
  await withRoleProviders({}, async () => {
    assert.equal((await post({ question: 'x'.repeat(501) })).status, 400);
  });
});

// ── Auth, identical policy to api/research.ts / api/researchStub.ts ────────────────────────

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
  await withEnv({ CARIBECON_RESEARCH_TOKEN: TOKEN }, async () => {
    assert.equal((await post({ question: 'ping' }, {})).status, 401);
    assert.equal((await post({ question: 'ping' }, { 'X-CaribEcon-Token': 'wrong' })).status, 401);
  });
});

test('rejects non-POST methods', async () => {
  const res = await ask.fetch(new Request('http://localhost/api/ask', { method: 'GET' }));
  assert.equal(res.status, 405);
});

// ── Role failures map to honest, non-leaking statuses ───────────────────────────────────────

test('an unconfigured interpret role is a 503, not a 500', async () => {
  await withEnv(
    { CARIBECON_RESEARCH_TOKEN: TOKEN, CARIBECON_INTERPRET_PROVIDER: undefined, CARIBECON_INTERPRET_MODEL: undefined },
    async () => {
      const res = await post({ question: 'GDP growth in Guyana?' });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'not_configured');
    },
  );
});

test('a model that never returns parseable JSON is a 502 model_error, with no raw model text leaked', async () => {
  await withRoleProviders({ interpretRespond: () => 'I cannot help with that.' }, async () => {
    const res = await post({ question: 'GDP growth in Guyana?' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'model_error');
    assert.ok(!body.message.includes('I cannot help with that.'));
  });
});
