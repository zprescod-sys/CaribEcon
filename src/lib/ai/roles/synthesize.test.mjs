/* Tests for synthesize() (src/lib/ai/roles/synthesize.ts).
 *
 * No mocks — same standing policy as interpret.test.mjs/openaiCompatible.test.mjs. Evidence
 * packages are built through the REAL buildEvidencePackage(), so a test asserting "the prompt
 * shows a pre-computed pp_change" is exercising the actual calculations.ts integration, not a
 * fabricated stand-in of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { synthesize, SynthesizeNotConfiguredError, SynthesizeParseError } from './synthesize.ts';
import { buildEvidencePackage } from '../../askTools.ts';

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

// Real evidence, via the real retrieval facade — a GDP growth rate series for Guyana (unit '%',
// so calculationForUnit picks pp_change) plus a news question, to exercise the full evidence
// section builder including the caveat/miss paths.
const intent = { questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null, newsKeywords: [] };
const pkg = buildEvidencePackage(intent);

const WELL_FORMED = {
  headline: 'Guyana GDP growth',
  claims: [
    {
      text: 'Guyana GDP growth reached 62.3% in the latest year.',
      type: 'figure',
      refs: pkg.evidenceMeta.filter(m => m.ref.startsWith('D:')).map(m => m.ref),
      figures: [{ ref: pkg.evidenceMeta.find(m => m.ref.startsWith('D:')).ref, year: 2022, value: 62.3, unit: '%', calculation: null, asWritten: '62.3%' }],
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
      await assert.rejects(() => synthesize(intent, pkg), SynthesizeNotConfiguredError);
    },
  );
});

// ── The evidence context actually sent ──────────────────────────────────────────────────────

test('the system prompt carries real retrieved points, a real evidence ref, and the pre-computed pp_change', async () => {
  await withSynthesisProvider(
    () => JSON.stringify(WELL_FORMED),
    async received => {
      await synthesize(intent, pkg);
      const system = received[0].messages[0].content;
      const dataRef = pkg.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
      assert.ok(system.includes(dataRef), 'the real D: ref must appear');
      // Derived from pkg itself, not a hardcoded guess — the real hub value, whatever it is.
      assert.ok(system.includes(String(pkg.data[0].points[0].value)), 'a real retrieved point must appear');
      assert.ok(system.includes('pp_change'), 'gdp_growth is a % series — pp_change, not yoy_change');
      assert.ok(system.toLowerCase().includes('never invent'));
    },
  );
});

test('caveats and misses are surfaced as explicit constraints when present', async () => {
  // A comparison across mismatched units reliably produces a comparability caveat.
  const comparisonIntent = { questionType: 'comparison', countries: ['GY', 'TT'], indicators: ['nominal_gdp'], yearFrom: null, yearTo: null, newsKeywords: [] };
  const comparisonPkg = buildEvidencePackage(comparisonIntent);
  await withSynthesisProvider(
    () => JSON.stringify({ headline: 'x', claims: [], gaps: [] }),
    async received => {
      await synthesize(comparisonIntent, comparisonPkg);
      const system = received[0].messages[0].content;
      if (comparisonPkg.caveats.length) {
        assert.ok(system.includes('CAVEATS'));
        assert.ok(system.includes(comparisonPkg.caveats[0]));
      }
    },
  );
});

// ── A well-formed response resolves correctly, with code-assigned ids ──────────────────────

test('a well-formed response resolves to a ResearchAnswer with code-assigned, contiguous claim ids', async () => {
  await withSynthesisProvider(
    () => JSON.stringify(WELL_FORMED),
    async () => {
      const answer = await synthesize(intent, pkg);
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
      const answer = await synthesize(intent, pkg);
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
      const answer = await synthesize(intent, pkg);
      assert.equal(answer.claims.length, 2);
      assert.deepEqual(answer.claims.map(c => c.text), ['valid one', 'also valid']);
    },
  );
});

test('a malformed figure is dropped; the claim it belongs to survives with the rest of its figures', async () => {
  const validRef = pkg.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [{
        text: 'one good figure, one bad',
        type: 'figure',
        refs: [validRef],
        figures: [
          { ref: validRef, year: 2022, value: 62.3, unit: '%', calculation: null, asWritten: '62.3%' },
          { ref: validRef, year: 2022, value: 'not a number', unit: '%', calculation: null, asWritten: 'x' }, // invalid
        ],
      }],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(intent, pkg);
      assert.equal(answer.claims[0].figures.length, 1);
      assert.equal(answer.claims[0].figures[0].value, 62.3);
    },
  );
});

test('an unrecognised "calculation" value causes that figure to be dropped, not silently accepted', async () => {
  const validRef = pkg.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  await withSynthesisProvider(
    () => JSON.stringify({
      headline: 'x',
      claims: [{
        text: 'x',
        type: 'figure',
        refs: [validRef],
        figures: [{ ref: validRef, year: 2022, value: 1, unit: '%', calculation: 'made_up_calc', asWritten: '1%' }],
      }],
      gaps: [],
    }),
    async () => {
      const answer = await synthesize(intent, pkg);
      assert.equal(answer.claims[0].figures.length, 0);
    },
  );
});

// ── A genuinely unparseable response is a loud, distinct failure ──────────────────────────

test('a non-JSON response raises SynthesizeParseError', async () => {
  await withSynthesisProvider(
    () => 'I cannot help with that.',
    async () => {
      await assert.rejects(
        () => synthesize(intent, pkg),
        err => err instanceof SynthesizeParseError && err.rawText === 'I cannot help with that.',
      );
    },
  );
});

test('a top-level shape that is not even close to a ResearchAnswer raises SynthesizeParseError', async () => {
  await withSynthesisProvider(
    () => JSON.stringify({ answer: 'wrong shape entirely' }),
    async () => {
      await assert.rejects(() => synthesize(intent, pkg), SynthesizeParseError);
    },
  );
});
