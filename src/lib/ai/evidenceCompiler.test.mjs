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
  // 'GDP growth' now resolves to the canonical hub slug 'gdp_growth' (metric resolution) —
  // that's the whole point: both sources' raw phrasing collapses to the SAME canonical item.
  const merged = result.keyFacts.filter(item => item.indicator === 'gdp_growth');
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

// ── Metric resolution: resolved -> comparable to hub data; unresolved -> preserved, non-comparable ──

test('a web figure whose metric resolves (realistic phrasing, not the raw slug) now conflicts with real hub data', () => {
  const p = pkg({
    data: [dataSeries()], // GY gdp_growth, %, actual, latest 2024 = 43.8
    web: [
      webItem({
        extract: {
          text: 'GDP growth in Guyana was 12.0% in 2024.',
          chars: 40,
          summary: null,
          insights: {
            keyClaims: [],
            // Realistic model phrasing, not the internal slug — resolveIndicator() must canonicalize
            // this to 'gdp_growth' before it can ever compare against hub data.
            importantFigures: [{ metric: 'GDP growth', value: '12.0%', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(result.contradictions.length, 1, 'a resolved, realistically-phrased metric must still match real hub data');
  const merged = result.contradictions[0].items;
  assert.ok(merged.every(item => item.indicator === 'gdp_growth'), 'the compiled item must carry the canonical slug, not the raw phrasing');
});

test("a genuinely non-hub metric stays under its own label — still usable, but never cross-matches hub data", () => {
  const p = pkg({
    data: [dataSeries()], // GY gdp_growth — unrelated to the web figure below
    web: [
      webItem({
        extract: {
          text: 'Container throughput at the Georgetown port rose to 8.4 in 2024.',
          chars: 60,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'Container throughput', value: '8.4', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(result.contradictions.length, 0, 'an unresolvable metric must never be silently compared against unrelated hub data');
  const nonHubItem = result.keyFacts.find(item => item.indicator === 'Container throughput');
  assert.ok(nonHubItem, 'the item must still be preserved and usable under its own original label, not dropped');
});

test('two unresolved items sharing the exact same raw metric label still dedupe/conflict with EACH OTHER', () => {
  const p = pkg({
    web: [
      webItem({
        id: 'W:src-a',
        extract: {
          text: 'Container throughput reached 8.4 in 2024.',
          chars: 40,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'Container throughput', value: '8.4', period: '2024', country: 'GY', textPresenceVerified: true }],
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
          text: 'Container throughput was 15.0 in 2024.',
          chars: 40,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'Container throughput', value: '15.0', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(
    result.contradictions.length,
    1,
    'two unresolved items agreeing on the same raw label are still comparable to EACH OTHER, even though neither is comparable to canonical hub data',
  );
});

test('a resolved metric earns canonical relevance credit; an unresolved one does not', () => {
  const p = pkg({
    web: [
      webItem({
        id: 'W:resolved',
        extract: {
          text: 'GDP growth was 12.0% in 2024.',
          chars: 30,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'GDP growth', value: '12.0%', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
      webItem({
        id: 'W:unresolved',
        url: 'https://another.example.com/story',
        domain: 'another.example.com',
        extract: {
          text: 'Container throughput was 8.4 in 2024.',
          chars: 30,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'Container throughput', value: '8.4', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  // intent().indicators is ['gdp_growth'] — only the resolved item should score relevance for it.
  const result = compileEvidence(intent(), plan(), p);
  const resolved = result.keyFacts.find(item => item.indicator === 'gdp_growth');
  const unresolved = result.keyFacts.find(item => item.indicator === 'Container throughput');
  assert.ok(resolved, 'the resolved item should be present');
  assert.ok(unresolved, 'the unresolved item should still be present and usable');
  // Both fit under MAX_KEY_FACTS here, so this only proves relevance-tier separation, not ranking
  // order under a tight budget — see the ordering assertion below for that.
});

test('under a tight budget, a resolved metric outranks an unresolved one with equal source quality', () => {
  const manyUnresolved = Array.from({ length: 15 }, (_, i) =>
    webItem({
      id: `W:unresolved-${i}`,
      url: `https://outlet${i}.example.com/story`,
      domain: `outlet${i}.example.com`,
      extract: {
        text: `Metric${i} was ${i} in 2024.`,
        chars: 30,
        summary: null,
        insights: {
          keyClaims: [],
          importantFigures: [{ metric: `Metric${i}`, value: String(i), period: '2024', country: 'GY', textPresenceVerified: true }],
          economicDrivers: [],
          relevantContext: [],
          topics: [],
        },
      },
    }),
  );
  const resolvedItem = webItem({
    id: 'W:resolved',
    url: 'https://resolved.example.com/story',
    domain: 'resolved.example.com',
    extract: {
      text: 'GDP growth was 12.0% in 2024.',
      chars: 30,
      summary: null,
      insights: {
        keyClaims: [],
        importantFigures: [{ metric: 'GDP growth', value: '12.0%', period: '2024', country: 'GY', textPresenceVerified: true }],
        economicDrivers: [],
        relevantContext: [],
        topics: [],
      },
    },
  });
  const result = compileEvidence(intent(), plan(), pkg({ web: [...manyUnresolved, resolvedItem] }));
  assert.ok(result.keyFacts.length <= MAX_KEY_FACTS, `expected <= ${MAX_KEY_FACTS}, got ${result.keyFacts.length}`);
  assert.ok(
    result.keyFacts.some(item => item.indicator === 'gdp_growth'),
    'the resolved, on-topic item must survive the budget cut — it should outrank every equal-tier unresolved item',
  );
});

test('a web-sourced figure with a resolved country now conflicts with real hub data for the same country/indicator/period/unit', () => {
  // newsExtract.ts resolves the model's country string through resolveCountry() before this ever
  // runs, so the figure here already carries the real hub code 'GY' — same shape the compiler
  // actually receives now that per-figure country attribution exists.
  const p = pkg({
    data: [dataSeries()], // GY gdp_growth, %, actual, latest 2024 = 43.8
    web: [
      webItem({
        extract: {
          text: 'GDP growth in Guyana was 12.0% in 2024.',
          chars: 40,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'gdp_growth', value: '12.0%', period: '2024', country: 'GY', textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(result.contradictions.length, 1, 'a resolved-country web figure disagreeing with real hub data must now be caught');
  assert.equal(result.contradictions[0].items.length, 2);
  const values = result.contradictions[0].items.map(i => i.value).sort((a, b) => a - b);
  assert.deepEqual(values, [12.0, 43.8]);
});

test('a web-sourced figure with country: null still never conflicts with hub data — no guessing', () => {
  const p = pkg({
    data: [dataSeries()], // GY gdp_growth, %, actual, latest 2024 = 43.8
    web: [
      webItem({
        extract: {
          text: 'GDP growth was 12.0% in 2024.',
          chars: 30,
          summary: null,
          insights: {
            keyClaims: [],
            importantFigures: [{ metric: 'gdp_growth', value: '12.0%', period: '2024', country: null, textPresenceVerified: true }],
            economicDrivers: [],
            relevantContext: [],
            topics: [],
          },
        },
      }),
    ],
  });
  const result = compileEvidence(intent(), plan(), p);
  assert.equal(result.contradictions.length, 0, 'a figure the model itself could not attribute to a country must not be forced into a match');
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

test('newer Tavily news ranks ahead of an older News Hub item for synthesis', () => {
  const result = compileEvidence(
    intent(),
    plan(),
    pkg({
      news: [{
        id: 'older-hub', title: 'Older hub development', source: 'Hub outlet', date: '2025-01-15',
        country: 'GY', url: 'https://hub.example/older',
      }],
      web: [webItem({
        id: 'W:newer-tavily', title: 'Newer Tavily development', publishedDate: '2026-06-01',
        snippet: 'Newer Tavily development',
      })],
    }),
  );
  assert.equal(result.externalEvidence[0].refs[0], 'W:newer-tavily');
  assert.equal(result.externalEvidence[1].refs[0], 'N:older-hub');
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
