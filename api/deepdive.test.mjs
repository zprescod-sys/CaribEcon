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
