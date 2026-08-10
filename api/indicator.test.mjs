/* Regression tests for api/indicator.ts — the endpoint behind CE.GDP / CE.GDPGROWTH /
 * CE.INDICATOR (plan §9 Phase 1). Picks a real country/indicator/year from the live hub via
 * getSeries rather than hardcoding one, so this does not go stale as data refreshes — same
 * discipline as the news.ts contract tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import indicator from './indicator.ts';
import { getSeries, getCountries, getIndicatorMeta } from '../src/lib/indicators.ts';

// A real, currently-sourced (non-null) point to exercise the happy path against.
function findRealPoint() {
  for (const c of getCountries()) {
    for (const m of getIndicatorMeta()) {
      const series = getSeries(c.code, m.slug);
      const point = series?.series.find(p => p.value !== null);
      if (point) return { country: c.code, indicator: m.slug, year: point.year, series, point };
    }
  }
  throw new Error('no non-null indicator point found in the hub — cannot exercise the happy path');
}

const url = (params) => `http://localhost/api/indicator?${new URLSearchParams(params)}`;
const get = (params) => indicator.fetch(new Request(url(params)));

test('a real, sourced country/indicator/year returns 200 with full provenance', async () => {
  const { country, indicator: slug, year, series, point } = findRealPoint();
  const res = get({ country, indicator: slug, year: String(year) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control') !== null, true, 'a successful lookup must be edge-cacheable');

  const body = await res.json();
  assert.equal(body.country, country);
  assert.equal(body.indicator, slug);
  assert.equal(body.year, year);
  assert.equal(body.value, point.value);
  assert.equal(body.type, point.type);
  assert.equal(body.vintage, point.vintage);
  for (const key of ['indicatorLabel', 'unit', 'source', 'sourceOrg', 'sourceTier', 'sourceUrl', 'confidence']) {
    assert.equal(body[key], series[key]);
  }
});

test('missing any required param returns 400, not a crash', () => {
  assert.equal(get({ country: 'TT', indicator: 'gdp_growth' }).status, 400); // no year
  assert.equal(get({ country: 'TT', year: '2020' }).status, 400); // no indicator
  assert.equal(get({ indicator: 'gdp_growth', year: '2020' }).status, 400); // no country
  assert.equal(get({}).status, 400);
});

test('a non-integer year returns 400', () => {
  assert.equal(get({ country: 'TT', indicator: 'gdp_growth', year: 'not-a-year' }).status, 400);
  assert.equal(get({ country: 'TT', indicator: 'gdp_growth', year: '2020.5' }).status, 400);
});

test('an indicator slug the hub does not carry returns 404, never a guess', async () => {
  const res = get({ country: 'TT', indicator: 'zzz_not_a_real_slug', year: '2020' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not_found');
});

test('a year outside the series coverage returns 404', () => {
  const res = get({ country: 'TT', indicator: 'gdp_growth', year: '1500' });
  assert.equal(res.status, 404);
});

test('a hub gap (stored null value) returns 404 rather than a null-valued 200', () => {
  // Scan for a real null point (SCHEMA.md documents 13 hub-wide); skip gracefully if the
  // current data has none, since which point is null can shift with a data refresh.
  for (const c of getCountries()) {
    for (const m of getIndicatorMeta()) {
      const series = getSeries(c.code, m.slug);
      const nullPoint = series?.series.find(p => p.value === null);
      if (nullPoint) {
        const res = get({ country: c.code, indicator: m.slug, year: String(nullPoint.year) });
        assert.equal(res.status, 404, `${c.code}/${m.slug}/${nullPoint.year} is a stored null and must not read as found`);
        return;
      }
    }
  }
});

test('OPTIONS preflight returns 204 with CORS headers', async () => {
  const res = indicator.fetch(new Request('http://localhost/api/indicator', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
