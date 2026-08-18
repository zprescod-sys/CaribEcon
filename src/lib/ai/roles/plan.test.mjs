/* Tests for plan() (src/lib/ai/roles/plan.ts).
 *
 * No mocks — same standing policy as interpret.test.mjs/openaiCompatible.test.mjs. Each test
 * stands up a real local HTTP server as the stand-in provider and points
 * CARIBECON_PLAN_PROVIDER's connection at it, so a test asserting "a step round-trips into a
 * ResearchPlan" is exercising the ACTUAL parseModelJson + coercion code path, not a mocked one
 * that could silently drift from it.
 *
 * Real hub codes/slugs (GY, TT, gdp_growth) — same convention as interpret.test.mjs/askTools.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { plan, PlanNotConfiguredError, PlanParseError } from './plan.ts';

const SAMPLE_INTENT = {
  questionType: 'indicator',
  countries: ['GY'],
  indicators: ['gdp_growth'],
  yearFrom: null,
  yearTo: null,
  newsKeywords: [],
};

/* Sets exactly the given env vars for the duration of `run`, restoring each key afterward — same
   helper as interpret.test.mjs, duplicated rather than shared for the same stated reason: three
   lines of setup, and it keeps each test file able to run standalone. */
function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* Stands up a stand-in provider and runs `test` with the plan role pointed at it. `respond`
   receives the parsed request body and returns the assistant's raw text content. */
async function withPlanProvider(respond, test_) {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      const text = respond(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    await withEnv(
      {
        CARIBECON_PLAN_PROVIDER: 'nebius',
        CARIBECON_PLAN_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => test_(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── Not configured — fails closed before any network call ──────────────────────────────────

test('throws PlanNotConfiguredError, with no network call, when the role is unconfigured', async () => {
  await withEnv({ CARIBECON_PLAN_PROVIDER: undefined, CARIBECON_PLAN_MODEL: undefined }, async () => {
    await assert.rejects(
      () => plan('What was GDP growth in Guyana?', SAMPLE_INTENT),
      PlanNotConfiguredError,
    );
  });
});

// ── The request actually sent ───────────────────────────────────────────────────────────────

test('sends the question as user content and embeds the real hub catalog + intent in the system prompt', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'directly answers the question' },
        ],
        anticipatedGaps: [],
      }),
    async received => {
      await plan('What was GDP growth in Guyana?', SAMPLE_INTENT);
      const [req] = received;
      assert.equal(req.messages[1].role, 'user');
      assert.equal(req.messages[1].content, 'What was GDP growth in Guyana?');
      assert.equal(req.messages[0].role, 'system');
      // Real hub data, not a placeholder — proves listCountries()/listIndicators() were actually called.
      assert.ok(req.messages[0].content.includes('GY=Guyana'));
      assert.ok(req.messages[0].content.includes('gdp_growth='));
      // The parsed intent is echoed into the prompt for context.
      assert.ok(req.messages[0].content.includes('countries: GY'));
      // All five real tool names are listed.
      for (const tool of ['get_series', 'compare_series', 'search_news', 'search_web', 'extract_web']) {
        assert.ok(req.messages[0].content.includes(tool), `expected tool "${tool}" in system prompt`);
      }
      assert.equal(req.temperature, 0);
    },
  );
});

// ── A well-formed response round-trips into a ResearchPlan ─────────────────────────────────

test('a well-formed model response round-trips into a ResearchPlan with the right shape', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: ['GY', 'TT'], indicators: ['gdp_growth'], yearFrom: 2020, yearTo: 2023 },
        steps: [
          { id: 's1', tool: 'compare_series', countries: ['GY', 'TT'], indicator: 'gdp_growth', yearFrom: 2020, yearTo: 2023, why: 'the question compares two economies' },
          { id: 's2', tool: 'search_news', countries: ['GY'], keywords: ['budget'], dateFrom: null, dateTo: null, why: 'recent context' },
          { id: 's3', tool: 'search_web', query: 'Guyana GDP growth 2023', dateFrom: null, dateTo: null, why: 'fill any gap' },
          { id: 's4', tool: 'extract_web', onStep: 's3', maxUrls: 2, why: 'read the top result' },
        ],
        anticipatedGaps: ['2023 may be a projection, not an actual'],
      }),
    async () => {
      const question = 'Compare GDP growth in Guyana and Trinidad since 2020';
      const result = await plan(question, SAMPLE_INTENT);

      // question is echoed verbatim, from the caller's own parameter — not the model's copy.
      assert.equal(result.question, question);
      assert.deepEqual(result.scope, { countries: ['GY', 'TT'], indicators: ['gdp_growth'], yearFrom: 2020, yearTo: 2023 });
      assert.equal(result.steps.length, 4);
      assert.deepEqual(result.steps[0], {
        id: 's1', tool: 'compare_series', countries: ['GY', 'TT'], indicator: 'gdp_growth',
        yearFrom: 2020, yearTo: 2023, why: 'the question compares two economies',
      });
      assert.deepEqual(result.steps[1], {
        id: 's2', tool: 'search_news', countries: ['GY'], keywords: ['budget'],
        dateFrom: null, dateTo: null, why: 'recent context',
      });
      assert.deepEqual(result.steps[2], {
        id: 's3', tool: 'search_web', query: 'Guyana GDP growth 2023',
        dateFrom: null, dateTo: null, why: 'fill any gap',
      });
      assert.deepEqual(result.steps[3], {
        id: 's4', tool: 'extract_web', onStep: 's3', maxUrls: 2, why: 'read the top result',
      });
      assert.deepEqual(result.anticipatedGaps, ['2023 may be a projection, not an actual']);
    },
  );
});

// ── Structural coercion: bad/duplicate ids and invalid tools are dropped, not kept ─────────

test('a step with an invalid "tool" value is dropped, the rest of the plan is kept', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'ok' },
          { id: 's2', tool: 'browse_the_web', query: 'not a real tool', why: 'invalid enum' },
        ],
        anticipatedGaps: [],
      }),
    async () => {
      const result = await plan('GDP growth in Guyana?', SAMPLE_INTENT);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].id, 's1');
    },
  );
});

test('a step missing a tool-required field (e.g. compare_series with no "countries") is dropped', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: [], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'compare_series', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'missing countries' },
        ],
        anticipatedGaps: [],
      }),
    async () => {
      const result = await plan('Compare GDP growth', SAMPLE_INTENT);
      assert.equal(result.steps.length, 0);
    },
  );
});

test('extract_web missing "onStep" is dropped', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: [], indicators: [], yearFrom: null, yearTo: null },
        steps: [{ id: 's1', tool: 'extract_web', maxUrls: 2, why: 'no onStep given' }],
        anticipatedGaps: [],
      }),
    async () => {
      const result = await plan('anything', SAMPLE_INTENT);
      assert.equal(result.steps.length, 0);
    },
  );
});

test('a duplicate step id keeps the first occurrence and drops the later one', async () => {
  await withPlanProvider(
    () =>
      JSON.stringify({
        scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'first' },
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'inflation', yearFrom: null, yearTo: null, why: 'duplicate id' },
        ],
        anticipatedGaps: [],
      }),
    async () => {
      const result = await plan('GDP growth in Guyana?', SAMPLE_INTENT);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].why, 'first');
    },
  );
});

// ── A genuinely unparseable response is a loud, distinct failure ──────────────────────────

test('a non-JSON response raises PlanParseError, never a silently empty plan', async () => {
  await withPlanProvider(
    () => 'I am not able to help with that.',
    async () => {
      await assert.rejects(
        () => plan('anything', SAMPLE_INTENT),
        err => err instanceof PlanParseError && err.rawText === 'I am not able to help with that.',
      );
    },
  );
});

test('a response whose "steps" is not an array raises PlanParseError', async () => {
  await withPlanProvider(
    () => JSON.stringify({ scope: {}, steps: 'not-an-array', anticipatedGaps: [] }),
    async () => {
      await assert.rejects(() => plan('anything', SAMPLE_INTENT), PlanParseError);
    },
  );
});

// ── Robust JSON extraction (same underlying parseModelJson as interpret.ts) ────────────────

test('a response wrapped in a ```json fence is still parsed correctly', async () => {
  await withPlanProvider(
    () =>
      '```json\n' +
      JSON.stringify({
        scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [{ id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'ok' }],
        anticipatedGaps: [],
      }) +
      '\n```',
    async () => {
      const result = await plan('GDP growth in Guyana?', SAMPLE_INTENT);
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].tool, 'get_series');
    },
  );
});
