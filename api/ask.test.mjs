/* Tests for api/ask.ts — the real Ask CaribEcon endpoint (interpret -> plan ->
 * validateResearchPlan -> executeResearchPlan -> synthesize, wrapped as the canonical
 * ResearchResult).
 *
 * No mocks — same standing policy as api/research.test.mjs and src/lib/ai/research.test.mjs.
 * Three real local HTTP servers stand in for the interpret, plan, and synthesis roles (distinct
 * provider names so each gets its own base-URL env var). The plan's own step (get_series for
 * GY/gdp_growth) runs against the REAL deterministic executor and hub — no Tavily/news-digest
 * step is used here, so no Tavily/article stand-in is needed for this endpoint-level suite; that
 * machinery is exercised in src/lib/ai/executor.test.mjs instead.
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

const postWithSignal = (body, signal) =>
  ask.fetch(
    new Request('http://localhost/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CaribEcon-Token': TOKEN,
        'x-forwarded-for': `198.51.100.${++callerCount % 250}`,
      },
      body: JSON.stringify(body),
      signal,
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

function jsonServer(respond, status = 200, delayMs = 0) {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const text = respond(JSON.parse(raw));
      setTimeout(() => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
      }, delayMs);
    });
  });
}

const INTERPRET_OK = () =>
  JSON.stringify({
    questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'],
    yearFrom: null, yearTo: null, newsKeywords: [],
  });
// A single get_series step, mirroring the intent above — validateResearchPlan resolves it
// against the real hub and executeResearchPlan runs it for real, so evidence.data actually
// gets populated exactly like the pre-Phase-3 buildEvidencePackage() path did.
const PLAN_OK = () =>
  JSON.stringify({
    scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
    steps: [
      { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test' },
    ],
    anticipatedGaps: [],
  });
const SYNTHESIZE_OK = () =>
  JSON.stringify({ headline: 'Guyana GDP growth', claims: [], gaps: [] });

async function withRoleProviders(
  {
    interpretRespond = INTERPRET_OK,
    planRespond = PLAN_OK,
    synthesisRespond = SYNTHESIZE_OK,
    interpretStatus = 200,
    interpretDelayMs = 0,
  },
  run,
) {
  const interpretServer = jsonServer(interpretRespond, interpretStatus, interpretDelayMs);
  const planServer = jsonServer(planRespond);
  const synthesisServer = jsonServer(synthesisRespond);
  await Promise.all([
    new Promise(resolve => interpretServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => planServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => synthesisServer.listen(0, '127.0.0.1', resolve)),
  ]);
  try {
    await withEnv(
      {
        // This helper stands up interpret/plan/synthesis stand-ins specifically to exercise the
        // staged two-call path through api/ask.ts, so it must pin CARIBECON_ROUTE_MODE now that
        // combined is the default — otherwise research() would reach for the (unconfigured, here)
        // routePlan role instead of these three servers. Same fix as research.test.mjs's
        // withResearchProviders.
        CARIBECON_ROUTE_MODE: 'staged',
        CARIBECON_RESEARCH_TOKEN: TOKEN,
        CARIBECON_INTERPRET_PROVIDER: 'nebius',
        CARIBECON_INTERPRET_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${interpretServer.address().port}`,
        NEBIUS_API_KEY: 'test-key',
        CARIBECON_PLAN_PROVIDER: 'noinfra',
        CARIBECON_PLAN_MODEL: 'test-model',
        NOINFRA_BASE_URL: `http://127.0.0.1:${planServer.address().port}`,
        NOINFRA_API_KEY: 'test-key',
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
      new Promise(resolve => planServer.close(resolve)),
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
      publishedHeadline: true,
      reasonCategories: [],
    });
    assert.equal(typeof body.elapsedMs, 'number');
  });
});

test('cancelling the client request aborts the active research pipeline', async () => {
  await withRoleProviders({ interpretDelayMs: 200 }, async () => {
    const controller = new AbortController();
    const response = postWithSignal({ question: 'GDP growth in Guyana?' }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    const res = await response;
    assert.equal(res.status, 499);
    assert.deepEqual(await res.json(), { error: 'request_cancelled' });
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

test('an unreachable research provider is a retryable 503 with a stable stage-aware code', async () => {
  await withRoleProviders({}, async () => {
    await withEnv({ NEBIUS_BASE_URL: 'http://127.0.0.1:1' }, async () => {
      const res = await post({ question: 'GDP growth in Guyana?' });
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error, 'provider_unreachable');
      assert.equal(body.stage, 'interpret');
      assert.equal(body.retryable, true);
      assert.equal(body.message, 'An AI service is temporarily unavailable. Please try again shortly.');
    });
  });
});

test('a missing configured model or endpoint is non-retryable and does not leak provider text', async () => {
  await withRoleProviders({ interpretStatus: 404 }, async () => {
    const res = await post({ question: 'GDP growth in Guyana?' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'provider_not_found');
    assert.equal(body.stage, 'interpret');
    assert.equal(body.retryable, false);
    assert.equal(body.message, 'The configured AI model or service endpoint is currently unavailable.');
    assert.equal(typeof body.requestId, 'string');
  });
});

test('a model that never returns parseable JSON is a 502 model_error, with no raw model text leaked', async () => {
  await withRoleProviders({ interpretRespond: () => 'I cannot help with that.' }, async () => {
    const res = await post({ question: 'GDP growth in Guyana?' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'model_error');
    assert.equal(body.stage, 'interpretation');
    assert.ok(!body.message.includes('I cannot help with that.'));
  });
});

test('interpret configured but plan unconfigured is a 503, not a 500', async () => {
  // withRoleProviders stands up all three role servers, then this deletes only plan's own env
  // vars afterward — proving interpret runs (and the plan role's own NotConfiguredError, not
  // interpret's, is what fires) rather than trivially exercising "nothing is configured".
  await withRoleProviders({}, async () => {
    await withEnv(
      { CARIBECON_PLAN_PROVIDER: undefined, CARIBECON_PLAN_MODEL: undefined },
      async () => {
        const res = await post({ question: 'GDP growth in Guyana?' });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).error, 'not_configured');
      },
    );
  });
});

test('a plan model that never returns parseable JSON is a 502 model_error, with no raw model text leaked', async () => {
  await withRoleProviders({ planRespond: () => 'I cannot help with that.' }, async () => {
    const res = await post({ question: 'GDP growth in Guyana?' });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'model_error');
    assert.equal(body.stage, 'planning');
    assert.ok(!body.message.includes('I cannot help with that.'));
  });
});

// ── Bounded conversational memory (sanitizeHistory, ARCHITECTURE.md §2.7 / §2.4 C3) ────────────
//
// Tested through the real endpoint, not by exporting sanitizeHistory for direct unit testing —
// same "no mocks, real integration path" policy this file states in its own header. The interpret
// stand-in receives the actual sanitized history baked into interpret()'s system prompt, so
// asserting on that captured request body proves what a real client's history actually becomes.

test('a "W:" ref in submitted history never reaches the interpret prompt — D:/N: refs do', async () => {
  let interpretRequestBody = null;
  await withRoleProviders(
    {
      interpretRespond: body => {
        interpretRequestBody = body;
        return INTERPRET_OK();
      },
    },
    async () => {
      await post({
        question: 'How is their overall economy looking?',
        history: [
          {
            question: "What are Trinidad's oil and gas exports?",
            headline: 'Trinidad oil exports rose in 2025',
            refs: ['D:TT:oil_exports', 'N:some-article-id', 'W:fabricated-web-evidence-id'],
          },
        ],
      });
    },
  );

  const system = interpretRequestBody.messages[0].content;
  assert.ok(system.includes('D:TT:oil_exports'), 'a real D: ref must reach the prompt');
  assert.ok(system.includes('N:some-article-id'), 'a real N: ref must reach the prompt');
  assert.ok(
    !system.includes('W:fabricated-web-evidence-id'),
    'a W: ref must NEVER reach the prompt — web evidence is turn-local and never trusted from a client',
  );
});

test('history entries beyond MAX_HISTORY_TURNS are clamped to the most recent, oldest dropped first', async () => {
  let interpretRequestBody = null;
  const history = Array.from({ length: 6 }, (_, i) => ({
    question: `Question number ${i}`,
    headline: `Headline number ${i}`,
    refs: [`D:GY:indicator_${i}`],
  }));

  await withRoleProviders(
    {
      interpretRespond: body => {
        interpretRequestBody = body;
        return INTERPRET_OK();
      },
    },
    async () => {
      await post({ question: 'A follow-up question', history });
    },
  );

  const system = interpretRequestBody.messages[0].content;
  // MAX_HISTORY_TURNS is 4 (config.ts) — only the last 4 of the 6 submitted turns (indices 2-5)
  // may appear; the two oldest (0, 1) must be forgotten entirely.
  assert.ok(!system.includes('Question number 0'), 'the oldest turn must be dropped');
  assert.ok(!system.includes('Question number 1'), 'the second-oldest turn must be dropped');
  assert.ok(system.includes('Question number 5'), 'the most recent turn must survive');
  assert.ok(system.includes('Question number 2'), 'the 4th-most-recent turn must survive (exactly at the cap)');
});

test('a malformed history (not an array, or entries missing a question) degrades to no history, never a 400', async () => {
  await withRoleProviders({}, async () => {
    const resNotArray = await post({ question: 'GDP growth in Guyana?', history: 'not-an-array' });
    assert.equal(resNotArray.status, 200);

    const resBadEntries = await post({
      question: 'GDP growth in Guyana?',
      history: [null, 42, { headline: 'no question field' }, { question: '   ' }],
    });
    assert.equal(resBadEntries.status, 200);
  });
});
