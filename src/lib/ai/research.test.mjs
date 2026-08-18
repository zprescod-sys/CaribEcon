/* Tests for research() (src/lib/ai/research.ts) — the
 * interpret -> plan -> validateResearchPlan -> executeResearchPlan -> synthesize -> verify
 * composition that produces the canonical ResearchResult.
 *
 * No mocks — same standing policy as interpret.test.mjs/synthesize.test.mjs/executor.test.mjs.
 * Three real local HTTP servers stand in for the interpret, plan, and synthesis roles (distinct
 * provider names so each gets its own base-URL env var); executeResearchPlan() runs for real
 * against the real hub via the REAL askTools.ts facade, so this exercises the actual
 * composition, not a fabricated stand-in of it.
 *
 * Deliberately coarser-grained than executor.test.mjs on the executor's own internals (Tavily
 * budgets, the news-digest concurrency, the one-shot re-plan, extract_web authorization — all
 * covered there for real). This file's job is the WIRING: that research() actually calls each
 * stage in order with the right arguments, and that all three miss sources (interpret's,
 * validateResearchPlan's, and executeResearchPlan's own) really do reach evidence.misses and the
 * synthesis prompt rather than any of them getting silently dropped on the way through. Plans
 * here stick to get_series/compare_series steps (never search_web/extract_web/search_news) so no
 * Tavily or news-article stand-in is needed just to prove the wiring is correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { research } from './research.ts';
import { InterpretNotConfiguredError } from './roles/interpret.ts';
import { PlanNotConfiguredError } from './roles/plan.ts';

/* async, and awaits `run()` itself before restoring — unlike a synchronous finally. research()
   composes several sequential role calls (interpret, then plan, then synthesize), and each
   later role's config read happens after an earlier role's `await`, i.e. after control would
   already have returned to a synchronous `finally`. Only the actual duration of `run()` guards
   the env for all three reads. */
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

function jsonServer(respond, received) {
  return createServer((req, res) => {
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
}

/* Stands up all three role providers (interpret on 'nebius', plan on 'noinfra', synthesis on
   'minimax' — distinct provider names so each points at its own stand-in server via its own
   base-URL env var, same convention research.test.mjs has always used) and runs `test_` with all
   three configured. */
async function withResearchProviders({ interpretRespond, planRespond, synthesisRespond }, test_) {
  const interpretReceived = [];
  const planReceived = [];
  const synthesisReceived = [];
  const interpretServer = jsonServer(interpretRespond, interpretReceived);
  const planServer = jsonServer(planRespond, planReceived);
  const synthesisServer = jsonServer(synthesisRespond, synthesisReceived);
  await Promise.all([
    new Promise(resolve => interpretServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => planServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => synthesisServer.listen(0, '127.0.0.1', resolve)),
  ]);

  try {
    await withEnv(
      {
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
      () => test_({ interpretReceived, planReceived, synthesisReceived }),
    );
  } finally {
    await Promise.all([
      new Promise(resolve => interpretServer.close(resolve)),
      new Promise(resolve => planServer.close(resolve)),
      new Promise(resolve => synthesisServer.close(resolve)),
    ]);
  }
}

const INTERPRET_OK = () =>
  JSON.stringify({
    questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'],
    yearFrom: null, yearTo: null, newsKeywords: [],
  });

// A single get_series step mirroring INTERPRET_OK's intent — validated for real by
// validateResearchPlan() and run for real by executeResearchPlan() against the real hub.
const PLAN_OK = () =>
  JSON.stringify({
    scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
    steps: [
      { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test' },
    ],
    anticipatedGaps: [],
  });

// ── Not configured — fails closed before any network call, at whichever stage is unconfigured ──

test('rejects with InterpretNotConfiguredError, no network call, when interpret is unconfigured', async () => {
  await withEnv(
    { CARIBECON_INTERPRET_PROVIDER: undefined, CARIBECON_INTERPRET_MODEL: undefined },
    async () => {
      await assert.rejects(() => research({ question: 'GDP growth in Guyana?' }), InterpretNotConfiguredError);
    },
  );
});

test('rejects with PlanNotConfiguredError when interpret succeeds but plan is unconfigured', async () => {
  const interpretReceived = [];
  const interpretServer = jsonServer(INTERPRET_OK, interpretReceived);
  await new Promise(resolve => interpretServer.listen(0, '127.0.0.1', resolve));
  try {
    await withEnv(
      {
        CARIBECON_INTERPRET_PROVIDER: 'nebius',
        CARIBECON_INTERPRET_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${interpretServer.address().port}`,
        NEBIUS_API_KEY: 'test-key',
        CARIBECON_PLAN_PROVIDER: undefined,
        CARIBECON_PLAN_MODEL: undefined,
      },
      async () => {
        await assert.rejects(() => research({ question: 'GDP growth in Guyana?' }), PlanNotConfiguredError);
        assert.equal(interpretReceived.length, 1, 'interpret must actually have run before plan() was reached');
      },
    );
  } finally {
    await new Promise(resolve => interpretServer.close(resolve));
  }
});

// ── The happy path composes into a canonical ResearchResult ────────────────────────────────

test('composes interpret -> plan -> validateResearchPlan -> executeResearchPlan -> synthesize into a ResearchResult with a real PASS verdict', async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      planRespond: body => {
        const system = body.messages[0].content;
        // The interpreted intent actually reached plan() — proves interpret -> plan wiring.
        assert.ok(system.includes('GY'));
        assert.ok(system.includes('gdp_growth'));
        return PLAN_OK();
      },
      synthesisRespond: body => {
        const system = body.messages[0].content;
        // Real evidence reached the synthesis prompt — proves executeResearchPlan() actually ran.
        assert.ok(system.includes('D:GY:gdp_growth'));
        return JSON.stringify({
          headline: 'Guyana GDP growth',
          claims: [
            { text: 'General context.', type: 'framing', refs: [], figures: [] },
            { text: 'More context.', type: 'framing', refs: [], figures: [] },
          ],
          gaps: [],
        });
      },
    },
    async () => {
      const result = await research({ question: 'GDP growth in Guyana?' });

      assert.equal(result.answer.headline, 'Guyana GDP growth');
      assert.deepEqual(result.answer.claims.map(c => c.id), ['claim-0', 'claim-1']);

      assert.equal(result.evidence.data[0].country, 'GY');
      assert.equal(result.evidence.data[0].indicator, 'gdp_growth');
      assert.ok(result.evidence.evidenceMeta.length > 0);

      assert.deepEqual(result.verdict, {
        outcome: 'PASS',
        grounding: { ran: true, violations: [] },
        audit: { ran: false },
        publishedClaims: ['claim-0', 'claim-1'],
        reasonCategories: [],
      });
    },
  );
});

// ── verify() is genuinely wired in, not just present with an all-empty synthetic answer ────

test('a synthesized claim citing a nonexistent ref is actually dropped by the real grounding gate', async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      planRespond: PLAN_OK,
      synthesisRespond: () =>
        JSON.stringify({
          headline: 'Guyana GDP growth',
          claims: [
            // Cites a ref that was never retrieved — a real check-1 (ref_existence) violation.
            { text: 'Fabricated context.', type: 'context', refs: ['D:XX:not_a_real_series'], figures: [] },
            { text: 'General context.', type: 'framing', refs: [], figures: [] },
          ],
          gaps: [],
        }),
    },
    async () => {
      const result = await research({ question: 'GDP growth in Guyana?' });

      assert.equal(result.verdict.outcome, 'NARROW');
      assert.deepEqual(result.verdict.publishedClaims, ['claim-1']);
      assert.ok(!result.verdict.publishedClaims.includes('claim-0'));
    },
  );
});

// ── All three miss sources merge into evidence.misses and reach the synthesis prompt ───────

test("a hallucinated country from interpret() is merged into evidence.misses and reaches the synthesis prompt", async () => {
  await withResearchProviders(
    {
      interpretRespond: () =>
        JSON.stringify({
          questionType: 'indicator', countries: ['Atlantis'], indicators: ['gdp_growth'],
          yearFrom: null, yearTo: null, newsKeywords: [],
        }),
      // Atlantis never resolves in interpret() (canonicaliseIntent strips it before plan() ever
      // sees it), so the intent handed to plan() has no country at all — plan() reasonably
      // returns an empty step list rather than guessing one.
      planRespond: () =>
        JSON.stringify({ scope: { countries: [], indicators: ['gdp_growth'], yearFrom: null, yearTo: null }, steps: [], anticipatedGaps: [] }),
      synthesisRespond: body => {
        const system = body.messages[0].content;
        assert.ok(system.includes('KNOWN GAPS'));
        assert.ok(system.includes('Atlantis'));
        return JSON.stringify({ headline: 'x', claims: [], gaps: ['Atlantis is not a covered economy.'] });
      },
    },
    async () => {
      const result = await research({ question: 'GDP growth in Atlantis?' });
      assert.ok(result.evidence.misses.some(m => m.kind === 'country' && m.detail.includes('Atlantis')));
      assert.deepEqual(result.verdict.publishedClaims, []);
    },
  );
});

test("a plan step naming an unresolvable country is dropped by validateResearchPlan and its miss reaches the synthesis prompt", async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      planRespond: () =>
        JSON.stringify({
          scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
          steps: [
            { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test' },
            // A country the model invented — validateResearchPlan (askTools.ts), not plan.ts's
            // own structural-only check, is what must catch this.
            { id: 's2', tool: 'get_series', country: 'Narnia', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test' },
          ],
          anticipatedGaps: [],
        }),
      synthesisRespond: body => {
        const system = body.messages[0].content;
        assert.ok(system.includes('Narnia'));
        return JSON.stringify({ headline: 'x', claims: [], gaps: [] });
      },
    },
    async () => {
      const result = await research({ question: 'GDP growth in Guyana and Narnia?' });
      assert.ok(result.evidence.misses.some(m => m.kind === 'country' && m.detail.includes('Narnia')));
      // The real GY step still ran despite the sibling step being dropped.
      assert.ok(result.evidence.data.some(d => d.country === 'GY'));
    },
  );
});

// ── retrievedAt threads through to the real, deterministic executeResearchPlan() ───────────

test('a fixed retrievedAt option produces a reproducible evidenceMeta.retrievedAt', async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      planRespond: PLAN_OK,
      synthesisRespond: () => JSON.stringify({ headline: 'x', claims: [], gaps: [] }),
    },
    async () => {
      const fixed = '2026-01-01T00:00:00.000Z';
      const result = await research({ question: 'GDP growth in Guyana?' }, { retrievedAt: fixed });
      assert.ok(result.evidence.evidenceMeta.every(m => m.retrievedAt === fixed));
    },
  );
});
