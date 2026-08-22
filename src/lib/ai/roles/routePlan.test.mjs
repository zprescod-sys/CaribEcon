/* Tests for routePlan() (src/lib/ai/roles/routePlan.ts) — the merged Interpret+Plan role.
 *
 * No mocks — same standing policy as interpret.test.mjs/plan.test.mjs. Each test stands up a real
 * local HTTP server as the stand-in provider and points CARIBECON_ROUTEPLAN_PROVIDER's connection
 * at it, so a test asserting "the model's slug resolves to a real hub record" or "a structurally
 * invalid step is dropped" is exercising the ACTUAL canonicaliseIntent/coercePlan integration, not
 * a mocked one that could silently drift from it.
 *
 * Real hub codes/slugs (GY, TT, gdp_growth, inflation) — same convention as askTools.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { routePlan, RoutePlanNotConfiguredError, RoutePlanParseError } from './routePlan.ts';

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

async function withRoutePlanProvider(respond, test_) {
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
        CARIBECON_ROUTEPLAN_PROVIDER: 'nebius',
        CARIBECON_ROUTEPLAN_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => test_(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function combinedResponse({ interpretation, plan }) {
  return JSON.stringify({
    interpretation: {
      questionType: 'indicator', countries: [], indicators: [], yearFrom: null, yearTo: null, newsKeywords: [],
      ...interpretation,
    },
    plan: { scope: { countries: [], indicators: [], yearFrom: null, yearTo: null }, steps: [], anticipatedGaps: [], ...plan },
  });
}

// ── Not configured — fails closed before any network call ──────────────────────────────────

test('throws RoutePlanNotConfiguredError, with no network call, when the role is unconfigured', async () => {
  await withEnv(
    { CARIBECON_ROUTEPLAN_PROVIDER: undefined, CARIBECON_ROUTEPLAN_MODEL: undefined },
    async () => {
      await assert.rejects(() => routePlan('What was GDP growth in Guyana?'), RoutePlanNotConfiguredError);
    },
  );
});

// ── The request actually sent — one call, catalog once, history reused from interpret.ts ────

test('sends the question as user content and embeds the real hub catalog in the system prompt exactly once', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({
      interpretation: { countries: ['GY'], indicators: ['gdp_growth'] },
      plan: { steps: [{ id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'x' }] },
    }),
    async received => {
      await routePlan('What was GDP growth in Guyana?');
      const [req] = received;
      assert.equal(req.messages[1].role, 'user');
      assert.equal(req.messages[1].content, 'What was GDP growth in Guyana?');
      assert.equal(req.messages[0].role, 'system');
      const system = req.messages[0].content;
      assert.ok(system.includes('GY=Guyana'));
      assert.ok(system.includes('gdp_growth='));
      // The catalog must appear exactly once — the whole point of merging is not sending it twice.
      assert.equal(system.split('GY=Guyana').length - 1, 1, 'country catalog must be embedded exactly once');
      assert.equal(req.temperature, 0);
    },
  );
});

test('the prompt describes all five tool shapes, same as plan.ts', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({}),
    async received => {
      await routePlan('anything');
      const system = received[0].messages[0].content;
      for (const tool of ['get_series', 'compare_series', 'search_news', 'search_web', 'extract_web']) {
        assert.ok(system.includes(tool), `prompt must describe the ${tool} tool shape`);
      }
    },
  );
});

// ── Part1→Part2 coupling fix (routeplanBenchmark.mjs live sweep, 2026-08-22) ───────────────
// A broad economy-state question ("How is Trinidad doing?") used to fall into "news" by default
// (defined only negatively) and leave "indicators" empty, which then starved the plan half of any
// structured step. These two bullets are the fix — assert they're both actually in the prompt.

test('the prompt tells the model to populate indicators for a broad economy-state question, not default it to "news"', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({}),
    async received => {
      await routePlan('anything');
      const system = received[0].messages[0].content;
      assert.ok(
        system.includes('is what starves Part 2 below of anything to retrieve'),
        'Part 1 must instruct the model to populate indicators for economy-state questions',
      );
      assert.ok(
        system.includes('under-planning against your own interpretation'),
        'Part 2 must tie its frugality rule to the indicators Part 1 already listed',
      );
    },
  );
});

// ── Bounded conversational memory — history reaches the combined prompt ────────────────────

test('with no history argument, the prompt carries no RECENT CONVERSATION section at all', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({}),
    async received => {
      await routePlan('What was GDP growth in Guyana?');
      const system = received[0].messages[0].content;
      assert.ok(!system.includes('RECENT CONVERSATION'));
    },
  );
});

test('a passed history turn appears in the prompt, and resolves a pronoun into BOTH halves of the output', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({
      interpretation: { countries: ['TT'], indicators: ['unemployment'] },
      plan: { steps: [{ id: 's1', tool: 'get_series', country: 'TT', indicator: 'unemployment', yearFrom: null, yearTo: null, why: 'x' }] },
    }),
    async received => {
      const result = await routePlan('What about its unemployment rate?', [
        {
          question: "What was Trinidad and Tobago's GDP growth?",
          headline: "Trinidad and Tobago's GDP growth was 2.1% in 2024",
          refs: ['D:TT:gdp_growth'],
        },
      ]);
      const system = received[0].messages[0].content;
      assert.ok(system.includes('RECENT CONVERSATION'));
      assert.ok(system.includes("Trinidad and Tobago's GDP growth"));
      assert.ok(system.includes('D:TT:gdp_growth'));
      // Both halves resolved the pronoun to the same country — the property this test is really for.
      assert.deepEqual(result.intent.countries, ['TT']);
      assert.equal(result.plan.steps[0].country, 'TT');
    },
  );
});

// ── A clean response resolves through the real canonicaliseIntent + coercePlan ─────────────

test('a well-formed combined response resolves BOTH halves via the real validators', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({
      interpretation: {
        questionType: 'comparison', countries: ['Guyana', 'Trinidad'], indicators: ['gdp_growth'],
        yearFrom: 2020, yearTo: 2023,
      },
      plan: {
        scope: { countries: ['GY', 'TT'], indicators: ['gdp_growth'], yearFrom: 2020, yearTo: 2023 },
        steps: [{ id: 's1', tool: 'compare_series', countries: ['GY', 'TT'], indicator: 'gdp_growth', yearFrom: 2020, yearTo: 2023, why: 'compare' }],
      },
    }),
    async () => {
      const result = await routePlan('Compare GDP growth in Guyana and Trinidad since 2020');
      assert.deepEqual(result.intent, {
        questionType: 'comparison',
        countries: ['GY', 'TT'], // resolved from free-text names, not codes — proves real resolution ran
        indicators: ['gdp_growth'],
        yearFrom: 2020,
        yearTo: 2023,
        newsKeywords: [],
      });
      assert.equal(result.misses.length, 0);
      assert.equal(result.plan.question, 'Compare GDP growth in Guyana and Trinidad since 2020');
      assert.equal(result.plan.steps.length, 1);
      assert.equal(result.plan.steps[0].tool, 'compare_series');
    },
  );
});

test('a hallucinated country in the interpretation half is stripped and recorded as a miss, never invented', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({ interpretation: { countries: ['Atlantis'], indicators: ['gdp_growth'] } }),
    async () => {
      const result = await routePlan('GDP growth in Atlantis?');
      assert.deepEqual(result.intent.countries, []);
      assert.ok(result.misses.some(m => m.kind === 'country' && m.detail.includes('Atlantis')));
    },
  );
});

test('question is always the caller\'s own parameter, never the model\'s copy of it', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({}),
    async () => {
      const result = await routePlan('the real question');
      assert.equal(result.plan.question, 'the real question');
    },
  );
});

// ── Structural plan validation reuses coercePlan() verbatim ────────────────────────────────

test('a structurally invalid step in the plan half is dropped; the rest of the plan is kept', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({
      plan: {
        steps: [
          { id: 's1', tool: 'compare_series', indicator: 'gdp_growth', why: 'missing countries array' },
          { id: 's2', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'valid' },
        ],
      },
    }),
    async () => {
      const result = await routePlan('anything');
      assert.equal(result.plan.steps.length, 1);
      assert.equal(result.plan.steps[0].id, 's2');
    },
  );
});

test('extract_web missing "onStep" is dropped, same as plan.ts', async () => {
  await withRoutePlanProvider(
    () => combinedResponse({ plan: { steps: [{ id: 's1', tool: 'extract_web', maxUrls: 3, why: 'x' }] } }),
    async () => {
      const result = await routePlan('anything');
      assert.equal(result.plan.steps.length, 0);
    },
  );
});

// ── Robust JSON extraction (shared parseModelJson — smoke test only) ───────────────────────

test('a response wrapped in a ```json fence is still parsed correctly', async () => {
  await withRoutePlanProvider(
    () => '```json\n' + combinedResponse({ interpretation: { countries: ['GY'], indicators: ['inflation'] } }) + '\n```',
    async () => {
      const result = await routePlan('inflation in Guyana');
      assert.deepEqual(result.intent.countries, ['GY']);
      assert.deepEqual(result.intent.indicators, ['inflation']);
    },
  );
});

// ── A genuinely unparseable response is a loud, distinct failure ──────────────────────────

test('a non-JSON response raises RoutePlanParseError, never a silently empty result', async () => {
  await withRoutePlanProvider(
    () => 'I am not able to help with that.',
    async () => {
      await assert.rejects(
        () => routePlan('anything'),
        err => err instanceof RoutePlanParseError && err.rawText === 'I am not able to help with that.',
      );
    },
  );
});

test('a response missing the "plan" half entirely raises RoutePlanParseError', async () => {
  await withRoutePlanProvider(
    () => JSON.stringify({
      interpretation: { questionType: 'indicator', countries: ['GY'], indicators: [], yearFrom: null, yearTo: null, newsKeywords: [] },
    }),
    async () => {
      await assert.rejects(() => routePlan('anything'), RoutePlanParseError);
    },
  );
});

test('a response whose "plan.steps" is not an array raises RoutePlanParseError', async () => {
  await withRoutePlanProvider(
    () => JSON.stringify({
      interpretation: { questionType: 'indicator', countries: [], indicators: [], yearFrom: null, yearTo: null, newsKeywords: [] },
      plan: { scope: { countries: [], indicators: [], yearFrom: null, yearTo: null }, steps: 'not-an-array', anticipatedGaps: [] },
    }),
    async () => {
      await assert.rejects(() => routePlan('anything'), RoutePlanParseError);
    },
  );
});
