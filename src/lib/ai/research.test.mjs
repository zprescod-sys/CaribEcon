/* Tests for research() (src/lib/ai/research.ts) — the interpret -> buildEvidencePackage ->
 * synthesize composition that produces the canonical ResearchResult.
 *
 * No mocks — same standing policy as interpret.test.mjs/synthesize.test.mjs. Two real local
 * HTTP servers stand in for the interpret and synthesis roles (different provider names so each
 * gets its own base-URL env var), and evidence is built through the REAL buildEvidencePackage(),
 * so this exercises the actual composition, not a fabricated stand-in of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { research } from './research.ts';
import { InterpretNotConfiguredError } from './roles/interpret.ts';

/* async, and awaits `run()` itself before restoring — unlike the single-role withEnv this file's
   siblings use. research() composes two sequential role calls (interpret then synthesize), and
   synthesize()'s config read happens after interpret()'s first `await`, i.e. after control would
   already have returned to a synchronous `finally`. Only the actual duration of `run()` guards
   the env for both reads. */
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

/* Stands up both role providers (interpret on 'nebius', synthesis on 'minimax' — distinct
   provider names so each points at its own stand-in server via its own base-URL env var) and
   runs `test_` with both configured. */
async function withResearchProviders({ interpretRespond, synthesisRespond }, test_) {
  const interpretReceived = [];
  const synthesisReceived = [];
  const interpretServer = jsonServer(interpretRespond, interpretReceived);
  const synthesisServer = jsonServer(synthesisRespond, synthesisReceived);
  await Promise.all([
    new Promise(resolve => interpretServer.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => synthesisServer.listen(0, '127.0.0.1', resolve)),
  ]);

  try {
    await withEnv(
      {
        CARIBECON_INTERPRET_PROVIDER: 'nebius',
        CARIBECON_INTERPRET_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${interpretServer.address().port}`,
        NEBIUS_API_KEY: 'test-key',
        CARIBECON_SYNTHESIS_PROVIDER: 'minimax',
        CARIBECON_SYNTHESIS_MODEL: 'test-model',
        MINIMAX_BASE_URL: `http://127.0.0.1:${synthesisServer.address().port}`,
        MINIMAX_API_KEY: 'test-key',
      },
      () => test_({ interpretReceived, synthesisReceived }),
    );
  } finally {
    await Promise.all([
      new Promise(resolve => interpretServer.close(resolve)),
      new Promise(resolve => synthesisServer.close(resolve)),
    ]);
  }
}

const INTERPRET_OK = () =>
  JSON.stringify({
    questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'],
    yearFrom: null, yearTo: null, newsKeywords: [],
  });

// ── Not configured — fails closed before any network call ──────────────────────────────────

test('rejects with InterpretNotConfiguredError, no network call, when interpret is unconfigured', async () => {
  await withEnv(
    { CARIBECON_INTERPRET_PROVIDER: undefined, CARIBECON_INTERPRET_MODEL: undefined },
    async () => {
      await assert.rejects(() => research({ question: 'GDP growth in Guyana?' }), InterpretNotConfiguredError);
    },
  );
});

// ── The happy path composes into a canonical ResearchResult ────────────────────────────────

test('composes interpret -> buildEvidencePackage -> synthesize into a ResearchResult with a stubbed PASS verdict', async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      synthesisRespond: body => {
        const system = body.messages[0].content;
        // Real evidence reached the synthesis prompt — proves buildEvidencePackage() actually ran.
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

// ── interpret()'s misses reach synthesis as a known gap, merged into the evidence package ──

test("a hallucinated country from interpret() is merged into evidence.misses and reaches the synthesis prompt", async () => {
  await withResearchProviders(
    {
      interpretRespond: () =>
        JSON.stringify({
          questionType: 'indicator', countries: ['Atlantis'], indicators: ['gdp_growth'],
          yearFrom: null, yearTo: null, newsKeywords: [],
        }),
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

// ── retrievedAt threads through to the real, deterministic buildEvidencePackage() ──────────

test('a fixed retrievedAt option produces a reproducible evidenceMeta.retrievedAt', async () => {
  await withResearchProviders(
    {
      interpretRespond: INTERPRET_OK,
      synthesisRespond: () => JSON.stringify({ headline: 'x', claims: [], gaps: [] }),
    },
    async () => {
      const fixed = '2026-01-01T00:00:00.000Z';
      const result = await research({ question: 'GDP growth in Guyana?' }, { retrievedAt: fixed });
      assert.ok(result.evidence.evidenceMeta.every(m => m.retrievedAt === fixed));
    },
  );
});
