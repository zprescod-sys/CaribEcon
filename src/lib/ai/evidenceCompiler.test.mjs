/* Tests for compileEvidence() (src/lib/ai/evidenceCompiler.ts).
 *
 * Pure function, no model call, no network — hand-built EvidencePackage/intent/plan fixtures
 * throughout, no mocks needed. The properties that matter most: dedup keeps the higher-tier
 * source while retaining every other source's ref; conflict detection is correctly normalized
 * (unit/frequency/valueType/transformation, not just metric+period); every compiled category
 * respects its hard budget cap regardless of how much raw evidence goes in; and a plain
 * Tavily-extract item's compiled form never leaks a slice of the real extract text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileEvidence } from './evidenceCompiler.ts';
import { MAX_KEY_FACTS, MAX_EXTERNAL_FINDINGS, MAX_CONTRADICTIONS } from './config.ts';

function intent(overrides = {}) {
  return {
    questionType: 'indicator',
    countries: ['GY'],
    indicators: ['gdp_growth'],
    yearFrom: null,
    yearTo: null,
    newsKeywords: [],
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    question: 'How is Guyana\'s GDP growth trending?',
    scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
    steps: [],
    anticipatedGaps: [],
    ...overrides,
  };
}

function pkg(overrides = {}) {
  return {
    data: [],
    news: [],
    misses: [],
    caveats: [],
    toolsUsed: [],
    newsCoverage: { earliest: '', latest: '', count: 0 },
    web: [],
    evidenceMeta: [],
    ...overrides,
  };
}

function dataSeries(overrides = {}) {
  return {
    country: 'GY',
    indicator: 'gdp_growth',
    label: 'GDP growth',
    unit: '%',
    source: 'IMF WEO',
    sourceOrg: 'IMF',
    sourceTier: 'comparable',
    sourceUrl: 'https://imf.org/weo',
    vintage: '2026-01',
    confidence: 'high',
    points: [
      { year: 2022, value: 5.0, type: 'actual' },
      { year: 2023, value: 33.0, type: 'actual' },
      { year: 2024, value: 43.8, type: 'actual' },
    ],
    ...overrides,
  };
}

function webItem(overrides = {}) {
  return {
    id: 'W:abc123',
    title: 'A Guyana economy article',
    url: 'https://example.com/article',
    domain: 'example.com',
    publishedDate: '2026-06-01',
    retrievedAt: '2026-06-01T00:00:00.000Z',
    snippet: 'A short search snippet about the economy.',
    extract: null,
    authorizedBy: 's1',
    ...overrides,
  };
}

// ── Basic normalize + shape ──────────────────────────────────────────────────────────────

test('compiles a data series into a small, representative set of statistic items, not one per year', () => {
  const result = compileEvidence(intent(), plan(), pkg({ data: [dataSeries()] }));
  // latest (2024) + latest yoy_change + period_average — 3 items, not 3 years x anything.
  assert.ok(result.keyFacts.length <= 4, `expected a compact set, got ${result.keyFacts.length}`);
  assert.ok(result.keyFacts.every(item => item.refs.includes('D:GY:gdp_growth')));
  const raw = result.keyFacts.find(item => item.transformation === null);
  assert.equal(raw.period, '2024');
  assert.equal(raw.value, 43.8);
});

test('an intent-scoped yearFrom adds the boundary point, still compact', () => {
  const result = compileEvidence(intent({ yearFrom: 2022 }), plan(), pkg({ data: [dataSeries()] }));
  const boundary = result.keyFacts.find(item => item.period === '2022' && item.transformation === null);
  assert.ok(boundary, 'expected the 2022 boundary point to be included');
  assert.equal(boundary.value, 5.0);
});

// ── Dedup: keeps higher tier, retains every ref ──────────────────────────────────────────

test('dedup keeps the higher-tier source and retains every originating ref', () => {
  const p = pkg({
    web: [
      webItem({
        id: 'W:primary-src',
        domain: 'imf.org',
        extract: {
          text: 'GDP growth reached 43.8% in 2024.',
          chars: 34,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
      webItem({
        id: 'W:secondary-src',
        url: 'https://otheroutlet.example.com/story',
        domain: 'otheroutlet.example.com',
        extract: {
          text: 'The economy grew by 43.8 percent in 2024.',
          chars: 42,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  const merged = result.keyFacts.filter(item => item.indicator === 'GDP growth');
  assert.equal(merged.length, 1, 'two agreeing sources for the same fact must collapse to one item');
  assert.equal(merged[0].compilerQualityTier, 'comparable', 'the imf.org source should win the tier comparison');
  assert.equal(merged[0].refs.length, 2, 'both originating refs must be retained, not just the winner\'s');
  assert.ok(merged[0].refs.includes('W:W:primary-src') || merged[0].refs.some(r => r.includes('primary-src')));
});

// ── Conflict detection: correctly normalized, not metric+period alone ───────────────────

test('a genuine same-everything-but-value mismatch is flagged as a contradiction', () => {
  const p = pkg({
    web: [
      webItem({
        id: 'W:src-a',
        extract: {
          text: 'GDP growth was 43.8% in 2024.',
          chars: 30,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
      webItem({
        id: 'W:src-b',
        url: 'https://another.example.com/story',
        domain: 'another.example.com',
        extract: {
          text: 'GDP growth was 12.0% in 2024.',
          chars: 30,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'GDP growth', value: '12.0%', period: '2024', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.contradictions[0].items.length, 2);
});

test('an annual figure and a monthly figure for the "same" metric+period do NOT falsely conflict', () => {
  // Same metric name and period, but a different unit — must not be compared as if comparable.
  const p = pkg({
    data: [dataSeries()], // GY gdp_growth, % , actual, latest 2024 = 43.8
    web: [
      webItem({
        extract: {
          text: 'Monthly GDP growth was reported at 3.5 index points in December 2024.',
          chars: 60,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'gdp_growth', value: '3.5', period: '2024' }], // no unit '%' -> 'unspecified'
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  // Different unit ('%' vs 'unspecified') means these must NOT collapse into one contradictory group.
  assert.equal(result.contradictions.length, 0, 'a differently-unit\'d figure must not be treated as a conflicting duplicate');
});

// ── Hard budget invariants ────────────────────────────────────────────────────────────────

test('keyFacts never exceeds MAX_KEY_FACTS regardless of how much data goes in', () => {
  const manySeries = Array.from({ length: 8 }, (_, i) =>
    dataSeries({ indicator: `indicator_${i}`, points: [
      { year: 2020, value: 1, type: 'actual' },
      { year: 2021, value: 2, type: 'actual' },
      { year: 2022, value: 3, type: 'actual' },
      { year: 2023, value: 4, type: 'actual' },
    ] }),
  );
  const result = compileEvidence(intent(), plan(), pkg({ data: manySeries }));
  assert.ok(result.keyFacts.length <= MAX_KEY_FACTS, `expected <= ${MAX_KEY_FACTS}, got ${result.keyFacts.length}`);
});

test('externalEvidence never exceeds MAX_EXTERNAL_FINDINGS regardless of how many news items go in', () => {
  const manyNews = Array.from({ length: 20 }, (_, i) => ({
    id: `news-${i}`,
    title: `Distinct headline number ${i}`,
    source: 'Some Outlet',
    date: '2026-01-01',
    country: 'GY',
    url: `https://example.com/${i}`,
  }));
  const result = compileEvidence(intent(), plan(), pkg({ news: manyNews }));
  assert.ok(result.externalEvidence.length <= MAX_EXTERNAL_FINDINGS, `expected <= ${MAX_EXTERNAL_FINDINGS}, got ${result.externalEvidence.length}`);
});

test('contradictions never exceeds MAX_CONTRADICTIONS', () => {
  const web = [];
  for (let i = 0; i < 6; i++) {
    web.push(
      webItem({
        id: `W:a-${i}`,
        url: `https://a${i}.example.com`,
        domain: `a${i}.example.com`,
        extract: {
          text: `Metric${i} was 10 in 2024.`,
          chars: 20,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: `Metric${i}`, value: '10', period: '2024' }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    );
    web.push(
      webItem({
        id: `W:b-${i}`,
        url: `https://b${i}.example.com`,
        domain: `b${i}.example.com`,
        extract: {
          text: `Metric${i} was 90 in 2024.`,
          chars: 20,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: `Metric${i}`, value: '90', period: '2024' }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    );
  }
  const result = compileEvidence(intent(), plan(), pkg({ web }));
  assert.ok(result.contradictions.length <= MAX_CONTRADICTIONS, `expected <= ${MAX_CONTRADICTIONS}, got ${result.contradictions.length}`);
});

// ── The compact-context requirement: no raw extract.text leaking into a plain Tavily item ──

test('a plain Tavily item (no structured insights) compiles from snippet only — never a slice of extract.text', () => {
  const longRealText = 'REAL_EXTRACT_MARKER_'.repeat(50); // 1000+ chars, would be an obvious leak if sliced in
  const p = pkg({
    web: [
      webItem({
        snippet: 'A short compact snippet.',
        extract: { text: longRealText, chars: longRealText.length, summary: null, insights: null },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  const allCompiledText = JSON.stringify(result);
  assert.ok(!allCompiledText.includes('REAL_EXTRACT_MARKER'), 'the compiled view must never contain the raw extract text');
  assert.ok(allCompiledText.includes('A short compact snippet'), 'the snippet itself should still be present');
});

// ── Gaps are deterministic, from pkg.misses, not model-generated ───────────────────────────

test('gaps are built directly from pkg.misses, one structured entry per miss', () => {
  const result = compileEvidence(
    intent(),
    plan(),
    pkg({ misses: [{ kind: 'country', detail: '"Atlantis" is not one of the 19 economies in the hub.' }] }),
  );
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].reason, '"Atlantis" is not one of the 19 economies in the hub.');
  assert.deepEqual(result.gaps[0].relatedRefs, []);
});

// ── economicConcepts is always empty (Knowledge Hub deferred) but correctly typed ──────────

test('economicConcepts is always an empty array — Knowledge Hub is a schema placeholder only', () => {
  const result = compileEvidence(intent(), plan(), pkg({ data: [dataSeries()] }));
  assert.deepEqual(result.economicConcepts, []);
});
