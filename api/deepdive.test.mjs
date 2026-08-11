/* Regression tests for api/deepdive.ts — Single Country Deep Dive's deterministic core
 * (plan §9 Phase 1 baseline, protected before Phase 2a is extended with charts/WorkbookPlan).
 * Deterministic, unauthenticated, token-free — every case here is a pure function of the
 * request body and the live hub, no network involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import deepdive from './deepdive.ts';

const post = (body) =>
  deepdive.fetch(
    new Request('http://localhost/api/deepdive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

test('a valid single-country request returns intent, per-indicator evidence, and a period average', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth', 'inflation'] });
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.intent.workflow, 'single_country');
  assert.equal(body.intent.country, 'GY');
  assert.deepEqual(body.intent.indicators.sort(), ['gdp_growth', 'inflation']);

  for (const slug of ['gdp_growth', 'inflation']) {
    const result = body.indicators[slug];
    assert.ok(result, `missing indicator result for ${slug}`);
    assert.equal(result.evidence.country, 'GY');
    assert.equal(result.evidence.indicator, slug);
    assert.ok(Array.isArray(result.evidence.points) && result.evidence.points.length > 0);
    assert.ok('value' in result.periodAverage);
    assert.ok('inputYears' in result.periodAverage);
  }
  assert.ok(Array.isArray(body.misses));
});

// ── Calculation, unit gating, chartSpec, workbookPlan (Phase 2a sub-step 2.2) ───────────────

test('a "%" indicator (gdp_growth, inflation) takes pp_change, never yoy_change', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth', 'inflation'] });
  const body = await res.json();
  for (const slug of ['gdp_growth', 'inflation']) {
    const { evidence, change } = body.indicators[slug];
    assert.equal(evidence.unit.trim(), '%');
    assert.equal(change.name, 'pp_change');
    assert.ok(Array.isArray(change.results) && change.results.length === evidence.points.length);
  }
});

test('a level indicator (nominal_gdp) takes yoy_change, never pp_change', async () => {
  const res = await post({ country: 'GY', indicators: ['nominal_gdp'] });
  const body = await res.json();
  const { evidence, change } = body.indicators.nominal_gdp;
  assert.notEqual(evidence.unit.trim(), '%');
  assert.equal(change.name, 'yoy_change');
});

test('the same underlying evidence yields very different pp_change vs yoy_change values', async () => {
  // Confirms the unit gate is load-bearing rather than cosmetic — a rate's yoy_change would be a
  // relative percentage change, which reads as a rate move and is the exact bug this gate avoids.
  const res = await post({ country: 'GY', indicators: ['gdp_growth'] });
  const { evidence, change } = (await res.json()).indicators.gdp_growth;
  const points = evidence.points.filter(p => p.value !== null);
  if (points.length < 2) return; // nothing to compare if the window has under two real points

  const ppResult = change.results.find(r => r.year === points[1].year);
  const relativeChange = ((points[1].value - points[0].value) / Math.abs(points[0].value)) * 100;
  assert.ok(
    Math.abs(ppResult.value - relativeChange) > 0.01 || points[0].value === points[1].value,
    'pp_change and the relative formula coincidentally matched — check the fixture picked a non-trivial pair',
  );
});

test('chartSpec is present per indicator and its year range matches retrieved points', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth'], yearFrom: 2019, yearTo: 2022 });
  const { evidence, chartSpec } = (await res.json()).indicators.gdp_growth;
  const years = evidence.points.filter(p => p.value !== null).map(p => p.year);
  assert.equal(chartSpec.indicator, 'gdp_growth');
  assert.deepEqual(chartSpec.countries, ['GY']);
  assert.equal(chartSpec.yearFrom, Math.min(...years));
  assert.equal(chartSpec.yearTo, Math.max(...years));
});

test('workbookPlan is present, internally consistent, and covers every succeeded indicator', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth', 'nominal_gdp'] });
  const body = await res.json();
  const { workbookPlan } = body;

  assert.ok(workbookPlan.sheetName.length > 0 && workbookPlan.sheetName.length <= 31);
  assert.ok(workbookPlan.evidenceSheetName.length > 0 && workbookPlan.evidenceSheetName.length <= 31);
  assert.notEqual(workbookPlan.sheetName.toLowerCase(), workbookPlan.evidenceSheetName.toLowerCase());

  const tableSections = workbookPlan.sections.filter(s => s.kind === 'table');
  assert.equal(tableSections.length, Object.keys(body.indicators).length);
  assert.equal(workbookPlan.charts.length, Object.keys(body.indicators).length);

  // Mixed units (% and GY$ mn) must produce the do-not-compare caveat on the actual endpoint
  // response, not just in the unit test fixtures.
  assert.ok(workbookPlan.caveats.some(c => /must not be differenced/i.test(c)));

  const known = new Set(workbookPlan.evidenceRows.map(r => r.evidenceId));
  for (const chart of workbookPlan.charts) {
    for (const id of chart.spec.evidenceIds) assert.ok(known.has(id));
  }
});

test('a retrieval miss still surfaces as a workbookPlan caveat, even alongside a succeeded indicator', async () => {
  // CW is World-Bank-spine only; fiscal_balance is absent for it (SCHEMA.md) — a real series miss.
  const res = await post({ country: 'CW', indicators: ['gdp_growth', 'fiscal_balance'] });
  const body = await res.json();
  assert.ok(body.indicators.gdp_growth);
  assert.ok(!('fiscal_balance' in body.indicators));
  assert.ok(body.workbookPlan.caveats.some(c => c.includes('fiscal_balance')));
});

test('a request where every indicator misses still returns a valid, if empty, workbookPlan', async () => {
  // CW/fiscal_balance alone: canonicalisation succeeds (a real slug), so this is a 200 with a
  // series miss, not a 400 — the endpoint's existing "series has no coverage" behavior.
  const res = await post({ country: 'CW', indicators: ['fiscal_balance'] });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(Object.keys(body.indicators).length, 0);
  assert.equal(body.workbookPlan.charts.length, 0);
  assert.equal(body.workbookPlan.sections.filter(s => s.kind === 'table').length, 0);
  assert.ok(body.workbookPlan.sheetName.length > 0, 'the plan must still name a sheet');
  assert.ok(body.workbookPlan.caveats.some(c => c.includes('fiscal_balance')));
});

test('a year window is honoured and trims the returned points', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth'], yearFrom: 2019, yearTo: 2021 });
  const body = await res.json();
  for (const p of body.indicators.gdp_growth.evidence.points) {
    assert.ok(p.year >= 2019 && p.year <= 2021);
  }
});

test('an unresolvable country returns 400 with a country miss, not a 200 with empty data', async () => {
  const res = await post({ country: 'Atlantis', indicators: ['gdp_growth'] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.misses.some(m => m.kind === 'country'));
});

test('no country at all returns 400 — Deep Dive needs exactly one economy', async () => {
  const res = await post({ indicators: ['gdp_growth'] });
  assert.equal(res.status, 400);
});

test('an indicator the hub does not carry is dropped and recorded as a miss, not fatal alone', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth', 'not_a_real_slug'] });
  assert.equal(res.status, 200, 'one valid indicator alongside a bad one should still succeed');
  const body = await res.json();
  assert.ok(body.indicators.gdp_growth);
  assert.ok(!('not_a_real_slug' in body.indicators));
  assert.ok(body.misses.some(m => m.kind === 'indicator'));
});

test('a request with only unresolvable indicators returns 400', async () => {
  const res = await post({ country: 'GY', indicators: ['not_a_real_slug'] });
  assert.equal(res.status, 400);
});

test('a series the hub has no coverage for at all returns a series-kind miss', async () => {
  // CW is World-Bank-spine only; fiscal_balance is IMF WEO and absent for it (SCHEMA.md).
  const res = await post({ country: 'CW', indicators: ['fiscal_balance'] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(!('fiscal_balance' in body.indicators));
  assert.ok(body.misses.some(m => m.kind === 'series'));
});

test('a year window outside the series coverage returns a years-kind miss', async () => {
  const res = await post({ country: 'GY', indicators: ['gdp_growth'], yearFrom: 1950, yearTo: 1960 });
  const body = await res.json();
  assert.ok(!('gdp_growth' in body.indicators));
  assert.ok(body.misses.some(m => m.kind === 'years'));
});

test('a malformed JSON body returns 400 rather than a 500', async () => {
  const res = await deepdive.fetch(
    new Request('http://localhost/api/deepdive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    }),
  );
  assert.equal(res.status, 400);
});

test('a non-POST method is rejected', async () => {
  const res = await deepdive.fetch(new Request('http://localhost/api/deepdive', { method: 'GET' }));
  assert.equal(res.status, 405);
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = await deepdive.fetch(new Request('http://localhost/api/deepdive', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('deterministic: the same request produces the same response', async () => {
  const body = { country: 'TT', indicators: ['gdp_growth', 'inflation'], yearFrom: 2018, yearTo: 2022 };
  const [a, b] = await Promise.all([post(body), post(body)]);
  assert.deepEqual(await a.json(), await b.json());
});
