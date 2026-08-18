/* Contract tests for the Ask retrieval facade (src/lib/askTools.ts) — the Phase 0 gate in the
 * build plan's section 9: canonicalisation, invalid intent handling, selected-country scope,
 * multiple comparison indicators, point-level vintages, missing coverage, unit comparability.
 *
 * Real hub codes and slugs (GY, TT, gdp_growth, inflation, nominal_gdp) are used throughout, the
 * same convention as excelIntent.test.mjs — a hub edit that breaks these breaks the add-in too.
 *
 * The load-bearing property under test everywhere below is that an unresolvable input becomes a
 * recorded RetrievalMiss and is dropped, never a plausible-looking guess. A wrong-but-valid slug
 * produces a confidently wrong answer, which is the failure mode this whole path exists to stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCountry,
  resolveIndicator,
  canonicaliseIntent,
  listCountries,
  listIndicators,
  getSeriesEvidence,
  getSelectedCountrySeries,
  buildEvidencePackage,
  evidenceId,
  validateResearchPlan,
} from './askTools.ts';
import { MAX_PLAN_STEPS } from './ai/config.ts';

// Convenience: a fully-formed intent so each test varies only the field it is about.
const intent = (over = {}) => ({
  questionType: 'indicator',
  countries: [],
  indicators: [],
  yearFrom: null,
  yearTo: null,
  newsKeywords: [],
  ...over,
});

// ── Canonicalisation ───────────────────────────────────────────────────────────────────────

test('resolveCountry accepts the hub code, the hub name, and any casing', () => {
  assert.equal(resolveCountry('GY'), 'GY');
  assert.equal(resolveCountry('gy'), 'GY');
  assert.equal(resolveCountry('Guyana'), 'GY');
  assert.equal(resolveCountry('  guyana  '), 'GY');
});

test('resolveCountry folds diacritics — "Curacao" and "Curaçao" both reach CW', () => {
  assert.equal(resolveCountry('Curacao'), 'CW');
  assert.equal(resolveCountry('Curaçao'), 'CW');
});

test('resolveCountry folds the St./Saint and & /and spellings a model actually emits', () => {
  assert.equal(resolveCountry('St. Kitts'), 'KN');
  assert.equal(resolveCountry('Saint Kitts'), 'KN');
  assert.equal(resolveCountry('St Vincent'), 'VC');
  assert.equal(resolveCountry('Trinidad'), 'TT');
  assert.equal(resolveCountry('The Bahamas'), 'BS');
});

test('resolveCountry returns null for anything unresolvable — never a nearest guess', () => {
  assert.equal(resolveCountry('Jamaicaa'), null);
  assert.equal(resolveCountry('Brazil'), null);
  assert.equal(resolveCountry('Montserrat'), null, 'MS is explicitly out of scope');
  assert.equal(resolveCountry(''), null);
});

test('resolveIndicator accepts both the canonical slug and the human label', () => {
  assert.equal(resolveIndicator('gdp_growth'), 'gdp_growth');
  assert.equal(resolveIndicator('GDP Growth Rate'), 'gdp_growth');
  assert.equal(resolveIndicator('inflation'), 'inflation');
});

test('resolveIndicator returns null for a slug the hub does not carry', () => {
  assert.equal(resolveIndicator('debt_to_gdp'), null, 'the merged legacy slug must not resolve');
  assert.equal(resolveIndicator('gini_coefficient'), null);
});

// ── Invalid intent handling ────────────────────────────────────────────────────────────────

test('canonicaliseIntent strips an unresolvable country and records it as a miss', () => {
  const { intent: out, misses } = canonicaliseIntent({ countries: ['Guyana', 'Atlantis'] });
  assert.deepEqual(out.countries, ['GY'], 'the bad value must not survive into the intent');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'country');
  assert.match(misses[0].detail, /Atlantis/);
});

test('canonicaliseIntent strips an unresolvable indicator and records it as a miss', () => {
  const { intent: out, misses } = canonicaliseIntent({ indicators: ['inflation', 'vibes'] });
  assert.deepEqual(out.indicators, ['inflation']);
  assert.equal(misses.filter(m => m.kind === 'indicator').length, 1);
});

test('canonicaliseIntent dedupes values that resolve to the same code', () => {
  const { intent: out } = canonicaliseIntent({
    countries: ['TT', 'Trinidad', 'trinidad and tobago'],
    indicators: ['gdp_growth', 'GDP Growth Rate'],
  });
  assert.deepEqual(out.countries, ['TT']);
  assert.deepEqual(out.indicators, ['gdp_growth']);
});

test('canonicaliseIntent defaults an unknown questionType to indicator', () => {
  assert.equal(canonicaliseIntent({ questionType: 'wizardry' }).intent.questionType, 'indicator');
  assert.equal(canonicaliseIntent({}).intent.questionType, 'indicator');
  assert.equal(canonicaliseIntent({ questionType: 'COMPARISON' }).intent.questionType, 'comparison');
  assert.equal(canonicaliseIntent({ questionType: 'news' }).intent.questionType, 'news');
});

test('canonicaliseIntent survives malformed input without throwing', () => {
  for (const raw of [null, undefined, {}, [], 'a string', 42, { countries: 'GY' }, { countries: [1, null] }]) {
    assert.doesNotThrow(() => canonicaliseIntent(raw), `threw on ${JSON.stringify(raw)}`);
  }
  // A non-array countries field is not silently coerced into a one-element list.
  assert.deepEqual(canonicaliseIntent({ countries: 'GY' }).intent.countries, []);
});

test('canonicaliseIntent rejects implausible years rather than passing them to retrieval', () => {
  assert.equal(canonicaliseIntent({ yearFrom: 1500 }).intent.yearFrom, null);
  assert.equal(canonicaliseIntent({ yearFrom: 2500 }).intent.yearFrom, null);
  assert.equal(canonicaliseIntent({ yearFrom: 2020.5 }).intent.yearFrom, null);
  assert.equal(canonicaliseIntent({ yearFrom: 'banana' }).intent.yearFrom, null);
  assert.equal(canonicaliseIntent({ yearFrom: 2020 }).intent.yearFrom, 2020);
  assert.equal(canonicaliseIntent({ yearFrom: '2020' }).intent.yearFrom, 2020);
});

test('canonicaliseIntent bounds newsKeywords so a model cannot widen retrieval indefinitely', () => {
  const many = Array.from({ length: 30 }, (_, i) => `kw${i}`);
  assert.equal(canonicaliseIntent({ newsKeywords: many }).intent.newsKeywords.length, 8);
});

// ── Deterministic tool surface ─────────────────────────────────────────────────────────────

test('listCountries returns all 19 economies as code/name pairs', () => {
  const countries = listCountries();
  assert.equal(countries.length, 19);
  for (const c of countries) {
    assert.match(c.code, /^[A-Z]{2}$/);
    assert.ok(c.name.length > 0);
  }
});

test('listIndicators omits unit deliberately and reports cross-country comparability', () => {
  const indicators = listIndicators();
  assert.equal(indicators.length, 24);
  for (const i of indicators) {
    assert.ok(!('unit' in i), 'unit belongs to a series, never to a slug');
    assert.equal(typeof i.comparable, 'boolean');
    assert.ok(Array.isArray(i.economies));
  }
  assert.equal(indicators.find(i => i.slug === 'gdp_growth').comparable, true);
  assert.equal(indicators.find(i => i.slug === 'nominal_gdp').comparable, false);
});

// ── Series evidence, provenance and vintages ───────────────────────────────────────────────

test('getSeriesEvidence returns full provenance, not just numbers', () => {
  const { evidence, miss } = getSeriesEvidence('GY', 'gdp_growth');
  assert.equal(miss, null);
  for (const key of ['country', 'indicator', 'label', 'unit', 'source', 'sourceOrg', 'sourceTier', 'sourceUrl', 'vintage', 'confidence']) {
    assert.ok(evidence[key], `evidence is missing "${key}" — a number without provenance is not shippable`);
  }
  assert.ok(evidence.points.length > 0);
});

test('point-level vintages: the reported vintage is the latest within the retrieved window', () => {
  const { evidence } = getSeriesEvidence('GY', 'gdp_growth');
  assert.match(evidence.vintage, /^\d{4}-\d{2}$/);
  // Narrowing the window must never report a vintage newer than the full-series one.
  const narrow = getSeriesEvidence('GY', 'gdp_growth', 2018, 2019);
  if (narrow.evidence) assert.ok(narrow.evidence.vintage <= evidence.vintage);
});

test('a year window trims points to the window and nothing outside it', () => {
  const { evidence } = getSeriesEvidence('GY', 'gdp_growth', 2019, 2021);
  assert.ok(evidence.points.length > 0);
  for (const p of evidence.points) {
    assert.ok(p.year >= 2019 && p.year <= 2021, `year ${p.year} escaped the window`);
  }
});

test('null values are preserved as null — never dropped, never coerced to 0', () => {
  for (const country of listCountries().map(c => c.code)) {
    const { evidence } = getSeriesEvidence(country, 'gdp_growth');
    if (!evidence) continue;
    for (const p of evidence.points) {
      assert.ok(
        p.value === null || typeof p.value === 'number',
        'a point value must be a number or an explicit null',
      );
      assert.ok(p.type, 'every point carries its actual/estimate/projection/derived type');
    }
  }
});

// ── Missing coverage ───────────────────────────────────────────────────────────────────────

test('an absent series returns a miss naming where the indicator IS carried', () => {
  // CW is World-Bank-spine only; fiscal_balance is IMF WEO and absent for it (SCHEMA.md).
  const { evidence, miss } = getSeriesEvidence('CW', 'fiscal_balance');
  assert.equal(evidence, null);
  assert.equal(miss.kind, 'series');
  assert.match(miss.detail, /CW/);
});

test('a window outside the series coverage returns a years miss, not an empty success', () => {
  const { evidence, miss } = getSeriesEvidence('GY', 'gdp_growth', 1950, 1960);
  assert.equal(evidence, null, 'an empty result must not be presented as a successful retrieval');
  assert.equal(miss.kind, 'years');
  assert.match(miss.detail, /\d{4}/, 'the miss must state the real coverage so the gap can be named');
});

// ── Selected-country scope ─────────────────────────────────────────────────────────────────

test('getSelectedCountrySeries honours the requested countries only', () => {
  const { evidence } = getSelectedCountrySeries(['TT', 'GY'], 'gdp_growth');
  assert.deepEqual(evidence.map(e => e.country).sort(), ['GY', 'TT']);
});

test('getSelectedCountrySeries caps at MAX_COMPARISON_COUNTRIES', () => {
  const all = listCountries().map(c => c.code);
  const { evidence } = getSelectedCountrySeries(all, 'gdp_growth');
  assert.ok(evidence.length <= 6, `returned ${evidence.length} series, above the 6-country bound`);
});

test('no named countries means the whole region for that indicator — the ranking-question shape', () => {
  const { evidence } = getSelectedCountrySeries([], 'gdp_growth');
  assert.ok(evidence.length > 6, 'an unscoped request should not be silently capped like a scoped one');
});

// ── buildEvidencePackage: routing ──────────────────────────────────────────────────────────

test('an indicator question retrieves one country and records the tool it used', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['gdp_growth'] }));
  assert.equal(pkg.data.length, 1);
  assert.equal(pkg.data[0].country, 'GY');
  assert.ok(pkg.toolsUsed.includes('getSeries'));
});

test('multiple indicators on one country are capped at MAX_INDICATORS', () => {
  const pkg = buildEvidencePackage(intent({
    countries: ['GY'],
    indicators: ['gdp_growth', 'inflation', 'unemployment', 'population', 'fdi'],
  }));
  assert.ok(pkg.data.length <= 3, `returned ${pkg.data.length} series, above the 3-indicator bound`);
});

test('a comparison naming only one economy records that as a miss', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT'], indicators: ['gdp_growth'],
  }));
  assert.ok(pkg.misses.some(m => m.kind === 'country' && /at least two/i.test(m.detail)));
});

test('a comparison uses the first indicator only, across the named economies', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT', 'GY'], indicators: ['gdp_growth', 'inflation'],
  }));
  assert.deepEqual([...new Set(pkg.data.map(d => d.indicator))], ['gdp_growth']);
  assert.ok(pkg.toolsUsed.includes('getSelectedCountrySeries'));
});

test('a question naming no hub indicator reports that rather than returning empty data', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'] }));
  assert.ok(pkg.misses.some(m => m.kind === 'indicator'));
});

test('an indicator question naming no economy reports that as a miss', () => {
  const pkg = buildEvidencePackage(intent({ indicators: ['gdp_growth'] }));
  assert.ok(pkg.misses.some(m => m.kind === 'country'));
});

// ── buildEvidencePackage: news branch ──────────────────────────────────────────────────────

test('a news question retrieves headlines and always attaches the metadata-only caveat', () => {
  const pkg = buildEvidencePackage(intent({ questionType: 'news', countries: ['GY'] }));
  assert.ok(pkg.toolsUsed.includes('searchNews'));
  assert.ok(pkg.news.length <= 6, 'news is bounded by MAX_NEWS');
  assert.ok(
    pkg.caveats.some(c => /headline metadata only/i.test(c)),
    'nothing downstream may imply an article body was read',
  );
});

test('a news question about an uncovered year reports the gap and names real coverage', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'news', countries: ['GY'], yearFrom: 1990, yearTo: 1990,
  }));
  assert.equal(pkg.news.length, 0, 'an uncovered period must not be filled with current headlines');
  const miss = pkg.misses.find(m => m.kind === 'news');
  assert.ok(miss, 'the coverage gap must be recorded, not silently empty');
  assert.match(miss.detail, /\d{4}-\d{2}-\d{2}/, 'the miss states the archive coverage');
});

test('newsCoverage travels with every package so an answer can state the archive extent', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['gdp_growth'] }));
  assert.match(pkg.newsCoverage.earliest, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pkg.newsCoverage.count > 0);
});

// ── Unit comparability ─────────────────────────────────────────────────────────────────────

test('mixed local-currency units raise a do-not-difference caveat', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT', 'GY'], indicators: ['nominal_gdp'],
  }));
  const units = new Set(pkg.data.map(d => d.unit));
  assert.ok(units.size > 1, 'fixture assumption: TT and GY report nominal GDP in different currencies');
  assert.ok(
    pkg.caveats.some(c => /do not difference, sum or rank/i.test(c)),
    'differencing local-currency levels across economies must be warned against',
  );
});

test('comparing a non-comparable indicator is flagged as indicative only', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT', 'GY'], indicators: ['nominal_gdp'],
  }));
  assert.ok(pkg.caveats.some(c => /indicative only/i.test(c)));
});

test('a same-unit comparison of a comparable indicator raises no unit caveat', () => {
  const pkg = buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT', 'GY'], indicators: ['gdp_growth'],
  }));
  assert.ok(!pkg.caveats.some(c => /do not difference/i.test(c)), 'percentages are safely comparable');
});

test('a single retrieved series never raises a cross-country comparability caveat', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['nominal_gdp'] }));
  assert.equal(pkg.data.length, 1);
  assert.ok(!pkg.caveats.some(c => /do not difference/i.test(c)));
});

// ── Package shape ──────────────────────────────────────────────────────────────────────────

test('every package returns the full EvidencePackage shape, even when nothing resolved', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['ZZ'], indicators: ['nonsense'] }));
  for (const key of ['data', 'news', 'misses', 'caveats', 'toolsUsed', 'newsCoverage', 'evidenceMeta']) {
    assert.ok(key in pkg, `missing "${key}" — the contract must not vary by outcome`);
  }
  assert.ok(Array.isArray(pkg.data) && Array.isArray(pkg.misses) && Array.isArray(pkg.evidenceMeta));
});

test('deterministic: the same intent AND the same retrievedAt produce the same package', () => {
  // retrievedAt is passed explicitly rather than relying on buildEvidencePackage's `new Date()`
  // default landing on the same millisecond twice — that would pass today by coincidence and
  // flake later. Passing it explicitly is what actually makes this a determinism test.
  const FIXED_RETRIEVED_AT = '2026-01-01T00:00:00.000Z';
  const build = () => buildEvidencePackage(intent({
    questionType: 'comparison', countries: ['TT', 'GY'], indicators: ['gdp_growth'], yearFrom: 2018, yearTo: 2022,
  }), FIXED_RETRIEVED_AT);
  assert.deepEqual(build(), build());
});

// ── evidenceMeta ───────────────────────────────────────────────────────────────────────────

test('evidenceMeta has one D: entry per data record and one N: entry per news record', () => {
  const FIXED_RETRIEVED_AT = '2026-03-01T12:00:00.000Z';
  const pkg = buildEvidencePackage(
    intent({ questionType: 'news', countries: ['GY'], indicators: ['gdp_growth'] }),
    FIXED_RETRIEVED_AT,
  );
  assert.equal(pkg.evidenceMeta.length, pkg.data.length + pkg.news.length);

  const dataRefs = pkg.data.map(d => `D:${d.country}:${d.indicator}`);
  const newsRefs = pkg.news.map(n => `N:${n.id}`);
  assert.deepEqual(pkg.evidenceMeta.map(m => m.ref).sort(), [...dataRefs, ...newsRefs].sort());

  for (const meta of pkg.evidenceMeta) {
    assert.equal(meta.retrievedAt, FIXED_RETRIEVED_AT);
    assert.equal(meta.sourceRevisionDate, null);
    assert.equal(meta.contentHash, null);
  }
});

test('evidenceMeta.vintage matches the source record — the series vintage for D:, null for N:', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['gdp_growth'] }));
  const dataMeta = pkg.evidenceMeta.find(m => m.ref.startsWith('D:'));
  assert.equal(dataMeta.vintage, pkg.data[0].vintage);

  const newsPkg = buildEvidencePackage(intent({ questionType: 'news', countries: ['GY'] }));
  for (const meta of newsPkg.evidenceMeta.filter(m => m.ref.startsWith('N:'))) {
    assert.equal(meta.vintage, null);
  }
});

test('a D: ref matches evidenceId(country, indicator) exactly — the single source of truth', () => {
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['gdp_growth'] }));
  const [d] = pkg.data;
  assert.ok(pkg.evidenceMeta.some(m => m.ref === `D:${evidenceId(d.country, d.indicator)}`));
});

test('evidenceMeta defaults to a real timestamp when retrievedAt is not supplied', () => {
  const before = Date.now();
  const pkg = buildEvidencePackage(intent({ countries: ['GY'], indicators: ['gdp_growth'] }));
  const after = Date.now();
  const stamped = new Date(pkg.evidenceMeta[0].retrievedAt).getTime();
  assert.ok(stamped >= before && stamped <= after, 'retrievedAt should default to "now"');
});

// ── validateResearchPlan ───────────────────────────────────────────────────────────────────
// Same discipline as canonicaliseIntent, applied to a Planner-emitted ResearchPlan: a step
// naming a real country/indicator survives, a step naming a fake one is dropped with a miss,
// and — the one genuinely new piece of behaviour — an extract_web step is only ever kept when
// its onStep names a real, EARLIER, already-validated search_web step, so a dropped search_web
// step also drops any extract_web step riding on it (cascading validation).

// Convenience: a fully-formed plan so each test varies only plan.steps.
const plan = (steps) => ({
  question: 'test question',
  scope: { countries: [], indicators: [], yearFrom: null, yearTo: null },
  steps,
  anticipatedGaps: [],
});

test('validateResearchPlan keeps a get_series step naming a real country/indicator untouched', () => {
  const step = {
    id: 's1', tool: 'get_series', country: 'Guyana', indicator: 'gdp_growth',
    yearFrom: null, yearTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 1);
  // resolveCountry canonicalises 'Guyana' -> 'GY'; the step's other fields pass through untouched.
  assert.deepEqual(out.steps[0], { ...step, country: 'GY', indicator: 'gdp_growth' });
  assert.equal(misses.length, 0);
});

test('validateResearchPlan drops a get_series step naming a fake country, and records a miss', () => {
  const step = {
    id: 's1', tool: 'get_series', country: 'Atlantis', indicator: 'gdp_growth',
    yearFrom: null, yearTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 0);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'country');
  assert.match(misses[0].detail, /Atlantis/);
});

test('validateResearchPlan drops a get_series step naming a fake indicator, and records a miss', () => {
  const step = {
    id: 's1', tool: 'get_series', country: 'GY', indicator: 'vibes',
    yearFrom: null, yearTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 0);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'indicator');
  assert.match(misses[0].detail, /vibes/);
});

test('validateResearchPlan partial-keeps compare_series countries, dropping only the ones that fail', () => {
  const step = {
    id: 's1', tool: 'compare_series', countries: ['Guyana', 'Atlantis', 'Trinidad'],
    indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 1);
  assert.deepEqual(out.steps[0].countries, ['GY', 'TT']);
  assert.equal(misses.filter(m => m.kind === 'country').length, 1);
});

test('validateResearchPlan drops a compare_series step entirely when every country fails', () => {
  const step = {
    id: 's1', tool: 'compare_series', countries: ['Atlantis', 'Narnia'],
    indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 0);
  assert.equal(misses.filter(m => m.kind === 'country').length, 2);
});

test('validateResearchPlan keeps a search_news step with an empty countries array — pan-Caribbean', () => {
  const step = {
    id: 's1', tool: 'search_news', countries: ['Atlantis'], keywords: ['tourism'],
    dateFrom: null, dateTo: null, why: 'test',
  };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 1);
  assert.deepEqual(out.steps[0].countries, []);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'country');
});

test('validateResearchPlan passes a search_web step through untouched — no country/indicator to resolve', () => {
  const step = { id: 's1', tool: 'search_web', query: 'IMF Article IV Guyana 2026', dateFrom: null, dateTo: null, why: 'test' };
  const { plan: out, misses } = validateResearchPlan(plan([step]));
  assert.equal(out.steps.length, 1);
  assert.deepEqual(out.steps[0], step);
  assert.equal(misses.length, 0);
});

test('validateResearchPlan keeps an extract_web step whose onStep names a real, earlier search_web step', () => {
  const search = { id: 's1', tool: 'search_web', query: 'IMF Article IV Guyana 2026', dateFrom: null, dateTo: null, why: 'test' };
  const extract = { id: 's2', tool: 'extract_web', onStep: 's1', maxUrls: 2, why: 'test' };
  const { plan: out, misses } = validateResearchPlan(plan([search, extract]));
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[1].id, 's2');
  assert.equal(misses.length, 0);
});

test('validateResearchPlan drops an extract_web step whose onStep does not name any step', () => {
  const search = { id: 's1', tool: 'search_web', query: 'IMF Article IV Guyana 2026', dateFrom: null, dateTo: null, why: 'test' };
  const extract = { id: 's2', tool: 'extract_web', onStep: 'nonexistent', maxUrls: 2, why: 'test' };
  const { plan: out, misses } = validateResearchPlan(plan([search, extract]));
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].id, 's1');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'step');
});

test('validateResearchPlan drops an extract_web step whose onStep names a step that is not search_web', () => {
  const series = {
    id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth',
    yearFrom: null, yearTo: null, why: 'test',
  };
  const extract = { id: 's2', tool: 'extract_web', onStep: 's1', maxUrls: 2, why: 'test' };
  const { plan: out, misses } = validateResearchPlan(plan([series, extract]));
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].id, 's1');
  assert.equal(misses.length, 1);
  assert.equal(misses[0].kind, 'step');
});

test('validateResearchPlan cascades: an extract_web step is ALSO dropped when the step it names was itself dropped', () => {
  // This is the specific case that proves "refuses any unauthorized Tavily call" actually works:
  // s1 fails resolution (fake country) and is dropped; s2's onStep names it. Because extract_web
  // is checked against the VALIDATED array, not the raw input plan, s1's absence from `validated`
  // means s2 finds no authorization and must cascade-drop too, even though s2 itself is otherwise
  // well-formed.
  const badSeries = {
    id: 's1', tool: 'get_series', country: 'Atlantis', indicator: 'gdp_growth',
    yearFrom: null, yearTo: null, why: 'test',
  };
  const extract = { id: 's2', tool: 'extract_web', onStep: 's1', maxUrls: 2, why: 'test' };
  const { plan: out, misses } = validateResearchPlan(plan([badSeries, extract]));
  assert.equal(out.steps.length, 0, 'both the invalid get_series step and the extract_web step depending on it must be gone');
  assert.equal(misses.filter(m => m.kind === 'country').length, 1, 's1 dropped for a fake country');
  assert.equal(misses.filter(m => m.kind === 'step').length, 1, 's2 cascade-dropped for an unauthorized onStep');
});

test('validateResearchPlan truncates a plan of more than MAX_PLAN_STEPS valid steps, keeping the first N in order', () => {
  const countries = listCountries().map(c => c.code);
  assert.ok(countries.length > MAX_PLAN_STEPS, 'fixture assumption: more real countries than MAX_PLAN_STEPS');
  const steps = countries.map((code, i) => ({
    id: `s${i}`, tool: 'get_series', country: code, indicator: 'gdp_growth',
    yearFrom: null, yearTo: null, why: 'test',
  }));
  const { plan: out, misses } = validateResearchPlan(plan(steps));
  assert.equal(out.steps.length, MAX_PLAN_STEPS);
  assert.deepEqual(out.steps.map(s => s.id), steps.slice(0, MAX_PLAN_STEPS).map(s => s.id));
  assert.equal(misses.length, 0, 'every step here is individually valid — truncation is not a validation miss');
});

test('validateResearchPlan passes question/scope/anticipatedGaps through unchanged', () => {
  const input = {
    question: 'How did GDP growth compare between Guyana and Trinidad?',
    scope: { countries: ['GY', 'TT'], indicators: ['gdp_growth'], yearFrom: 2020, yearTo: 2024 },
    steps: [],
    anticipatedGaps: ['no coverage before 2015'],
  };
  const { plan: out } = validateResearchPlan(input);
  assert.equal(out.question, input.question);
  assert.deepEqual(out.scope, input.scope);
  assert.deepEqual(out.anticipatedGaps, input.anticipatedGaps);
});
