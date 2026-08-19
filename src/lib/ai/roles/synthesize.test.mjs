/* Tests for synthesize() (src/lib/ai/roles/synthesize.ts) — Stage C of the Synthesis Latency +
 * Evidence Compiler upgrade: this role now reads CompiledEvidence (evidenceCompiler.ts's output),
 * not a raw EvidencePackage directly.
 *
 * No mocks — same standing policy as interpret.test.mjs/openaiCompatible.test.mjs. Evidence
 * packages are built through the REAL buildEvidencePackage() and REAL compileEvidence(), so a
 * test asserting "the prompt shows a compiled key fact" is exercising the actual integration,
 * not a fabricated stand-in of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { synthesize, SynthesizeNotConfiguredError, SynthesizeParseError } from './synthesize.ts';
import { buildEvidencePackage } from '../../askTools.ts';
import { compileEvidence } from '../evidenceCompiler.ts';
import { MAX_VISIBLE_CLAIMS } from '../config.ts';

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

async function withSynthesisProvider(respond, test_) {
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
        CARIBECON_SYNTHESIS_PROVIDER: 'nebius',
        CARIBECON_SYNTHESIS_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => test_(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// Real evidence, via the real retrieval facade + real compiler — a GDP growth rate series for
// Guyana (unit '%', so calculationForUnit picks pp_change), compiled the same way research.ts
// actually does it.
const intent = { questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null, newsKeywords: [] };
const pkg = buildEvidencePackage(intent);
const researchPlan = { question: 'How is Guyana\'s GDP growth trending?', scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null }, steps: [], anticipatedGaps: [] };
const compiled = compileEvidence(intent, researchPlan, pkg);
const realRef = compiled.keyFacts[0]?.refs[0];

const WELL_FORMED = {
  headline: 'Guyana GDP growth',
  claims: [
    {
      text: 'Guyana GDP growth reached 62.3% in the latest year.',
      type: 'figure',
      refs: [realRef],
      figures: [{ ref: realRef, year: 2022, value: 62.3, unit: '%', calculation: null, asWritten: '62.3%' }],
    },
    {
      text: 'Figures should be read alongside broader regional context.',
      type: 'framing',
      refs: [],
      figures: [],
    },
  ],
  gaps: [],
};

// ── Not configured — fails closed before any network call ──────────────────────────────────

test('throws SynthesizeNotConfiguredError, with no network call, when the role is unconfigured', async () => {
  await withEnv(
    { CARIBECON_SYNTHESIS_PROVIDER: undefined, CARIBECON_SYNTHESIS_MODEL: undefined },
    async () => {
      await assert.rejects(() => synthesize(compiled), SynthesizeNotConfiguredError);
    },
  );
});

// ── The compiled evidence actually sent ─────────────────────────────────────────────────────

test('the system prompt carries a real compiled key fact and its pre-computed pp_change', async () => {
  await withSynthesisProvider(
    () => JSON.stringify(WELL_FORMED),
    async received => {
      await synthesize(compiled);
      const system = received[0].messages[0].content;
      assert.ok(system.includes('KEY FACTS'));
      assert.ok(system.includes(realRef), 'the real D: ref must appear');
      assert.ok(system.includes('pp_change'), 'gdp_growth is a % series — pp_change, not yoy_change');
      assert.ok(system.toLowerCase().includes('analyst'), 'the analyst-voice framing must be present');
      assert.ok(system.includes(compiled.question), 'compiled.question must reach the prompt verbatim');
    },
  );
});

test('driver evidence and external context appear in their own grouped sections, and mechanism-bearing items land in drivers', async () => {
  const webPkg = {
    ...pkg,
    web: [
      {
        id: 'W:driver-item',
        title: 'Article with a driver',
        url: 'https://example.com/a',
        domain: 'example.com',
        publishedDate: '2026-01-01',
        retrievedAt: '2026-01-01T00:00:00.000Z',
        snippet: 'a short snippet',
        extract: {
          text: 'Oil output drove GDP growth.'.repeat(20),
          chars: 500,
          summary: null,
          insights: {
            keyClaims: ['A KEY_CLAIM_MARKER fact.'],
            importantFigures: [],
            economicDrivers: [{ driver: 'Oil output', mechanism: 'DRIVER_MECHANISM_MARKER', evidence: 'x', confidence: 'high' }],
            relevantContext: [],
            topics: ['oil'],
          },
        },
        authorizedBy: 's1',
      },
    ],
  };
  const webCompiled = compileEvidence(intent, researchPlan, webPkg);
  await withSynthesisProvider(
    () => JSON.stringify({ headline: 'x', claims: [], gaps: [] }),
    async received => {
      await synthesize(webCompiled);
      const system = received[0].messages[0].content;
      assert.ok(system.includes('POSSIBLE ECONOMIC DRIVERS'));
      assert.ok(system.includes('DRIVER_MECHANISM_MARKER'), 'a driver item\'s mechanism must appear under drivers');
      assert.ok(system.includes('KEY_CLAIM_MARKER'), 'a non-driver key claim must still appear somewhere (external context)');
      // The whole raw extract text (repeated 20x) must never leak into the prompt — only the
      // compiler's structured, compact items may.
      assert.ok(!system.includes('Oil output drove GDP growth.'.repeat(5)), 'raw extract text must not leak into the prompt');
    },
  );
});

test('caveats are surfaced as explicit hard constraints when present', async () => {
  // A comparison across mismatched units reliably produces a comparability caveat.
  const comparisonIntent = { questionType: 'comparison', countries: ['GY', 'TT'], indicators: ['nominal_gdp'], yearFrom: null, yearTo: null, newsKeywords: [] };
  const comparisonPkg = buildEvidencePackage(comparisonIntent);
  const comparisonPlan = { question: 'Compare nominal GDP', scope: { countries: ['GY', 'TT'], indicators: ['nominal_gdp'], yearFrom: null, yearTo: null }, steps: [], anticipatedGaps: [] };
  const comparisonCompiled = compileEvidence(comparisonIntent, comparisonPlan, comparisonPkg);
  await withSynthesisProvider(
    () => JSON.stringify({ headline: 'x', claims: [], gaps: [] }),
    async received => {
      await synthesize(comparisonCompiled);
      const system = received[0].messages[0].content;
      if (comparisonCompiled.caveats.length) {
        assert.ok(system.includes('CAVEATS'));
        assert.ok(system.includes(comparisonCompiled.caveats[0]));
      }
    },
  );
});

// ── A well-formed response resolves correctly, with code-assigned ids ──────────────────────

test('a well-formed response resolves to a ResearchAnswer with code-assigned, contiguous claim ids', async () => {
  await withSynthesisProvider(
    () => JSON.stringify(WELL_FORMED),
    async () => {
      const answer = await synthesize(compiled);
      assert.equal(answer.headline, 'Guyana GDP growth');
      assert.equal(answer.claims.length, 2);
      assert.equal(answer.claims[0].id, 'claim-0');
      assert.equal(answer.claims[1].id, 'claim-1');
      assert.equal(answer.claims[0].figures[0].value, 62.3);
    },
  );
});

test('refs: [] is accepted for type "framing" but the claim is dropped for any other type', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [
        { text: 'general commentary', type: 'framing', refs: [], figures: [] },
        { text: 'a figure claim with no refs', type: 'figure', refs: [], figures: [] }, // invalid — dropped
      ],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(compiled);
      assert.equal(answer.claims.length, 1);
      assert.equal(answer.claims[0].type, 'framing');
    },
  );
});

// ── Structural validation drops bad pieces without failing the whole answer ────────────────

test('a structurally invalid claim is dropped; well-formed claims around it are kept', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [
        { text: 'valid one', type: 'framing', refs: [], figures: [] },
        { text: 'missing type entirely' }, // invalid
        { text: 'also valid', type: 'context', refs: ['N:some-id'], figures: [] },
      ],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(compiled);
      assert.equal(answer.claims.length, 2);
      assert.deepEqual(answer.claims.map(c => c.text), ['valid one', 'also valid']);
    },
  );
});

test('a malformed figure is dropped; the claim it belongs to survives with the rest of its figures', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [{
        text: 'one good figure, one bad',
        type: 'figure',
        refs: [realRef],
        figures: [
          { ref: realRef, year: 2022, value: 62.3, unit: '%', calculation: null, asWritten: '62.3%' },
          { ref: realRef, year: 2022, value: 'not a number', unit: '%', calculation: null, asWritten: 'x' }, // invalid
        ],
      }],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(compiled);
      assert.equal(answer.claims[0].figures.length, 1);
      assert.equal(answer.claims[0].figures[0].value, 62.3);
    },
  );
});

test('an unrecognised "calculation" value causes that figure to be dropped, not silently accepted', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [{
        text: 'x',
        type: 'figure',
        refs: [realRef],
        figures: [{ ref: realRef, year: 2022, value: 1, unit: '%', calculation: 'made_up_calc', asWritten: '1%' }],
      }],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(compiled);
      assert.equal(answer.claims[0].figures.length, 0);
    },
  );
});

// ── Visible-answer ceiling — enforced in code, not left to the prompt alone ────────────────

test('claims are capped at MAX_VISIBLE_CLAIMS, without mutating any kept claim\'s text', async () => {
  const manyClaims = Array.from({ length: MAX_VISIBLE_CLAIMS + 5 }, (_, i) => ({
    text: `Claim number ${i}, unmodified text that must survive verbatim if kept.`,
    type: 'framing',
    refs: [],
    figures: [],
  }));
  await withSynthesisProvider(
    () => JSON.stringify({ headline: 'x', claims: manyClaims, gaps: [] }),
    async () => {
      const answer = await synthesize(compiled);
      assert.ok(answer.claims.length <= MAX_VISIBLE_CLAIMS, `expected <= ${MAX_VISIBLE_CLAIMS}, got ${answer.claims.length}`);
      // Every kept claim's text is verbatim, unmodified — only whole claims are dropped.
      for (const claim of answer.claims) {
        assert.ok(claim.text.endsWith('must survive verbatim if kept.'));
      }
    },
  );
});

test('a very long set of claims is truncated further to stay near the visible-answer token target', async () => {
  const longClaims = Array.from({ length: MAX_VISIBLE_CLAIMS }, (_, i) => ({
    text: `Claim ${i}: `.padEnd(2000, 'x'), // each ~2000 chars ~= 500 tokens; several blow well past 1200
    type: 'framing',
    refs: [],
    figures: [],
  }));
  await withSynthesisProvider(
    () => JSON.stringify({ headline: 'x', claims: longClaims, gaps: [] }),
    async () => {
      const answer = await synthesize(compiled);
      assert.ok(answer.claims.length < MAX_VISIBLE_CLAIMS, 'the token cap must drop claims below the count cap when they are individually long');
    },
  );
});

// ── A genuinely unparseable response is a loud, distinct failure ──────────────────────────

test('a non-JSON response raises SynthesizeParseError', async () => {
  await withSynthesisProvider(
    () => 'I cannot help with that.',
    async () => {
      await assert.rejects(
        () => synthesize(compiled),
        err => err instanceof SynthesizeParseError && err.rawText === 'I cannot help with that.',
      );
    },
  );
});

test('a top-level shape that is not even close to a ResearchAnswer raises SynthesizeParseError', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({ answer: 'wrong shape entirely' }),
    async () => {
      await assert.rejects(() => synthesize(compiled), SynthesizeParseError);
    },
  );
});
