/* Regression tests for api/snapshot.ts (plan §9 Phase 1: "protect Browse, shared snapshot
 * loading, seven custom functions... with regression checks"). This is the wire contract every
 * CE.* custom function and excel-addin/src/shared/hub.js depend on — a silent shape change here
 * would break the entire add-in without ever touching add-in code, so it is pinned here rather
 * than only being caught by a manual Excel smoke test.
 *
 * Called in-process via the module's exported `fetch(Request): Response`, same convention as
 * every other test in this suite — no server, no network, no token spend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import snapshot from './snapshot.ts';

const get = () => snapshot.fetch(new Request('http://localhost/api/snapshot'));

test('GET returns 200 with the CORS + long-lived cache headers hub.js relies on', () => {
  const res = get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'application/json');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.match(res.headers.get('Cache-Control') ?? '', /s-maxage=3600/);
});

test('OPTIONS preflight returns 204 with CORS headers, no body', async () => {
  const res = snapshot.fetch(new Request('http://localhost/api/snapshot', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await res.text(), '');
});

test('payload top-level shape: version, countries, indicators, series', async () => {
  const body = await get().json();
  for (const key of ['version', 'countries', 'indicators', 'series']) {
    assert.ok(key in body, `snapshot is missing "${key}" — hub.js destructures this exact shape`);
  }
  assert.equal(typeof body.version, 'string');
  assert.ok(body.version.length > 0);
});

test('countries: all 19 economies as code/name pairs, no more, no fewer', async () => {
  const { countries } = await get().json();
  assert.equal(countries.length, 19);
  for (const c of countries) {
    assert.match(c.code, /^[A-Z]{2}$/);
    assert.ok(typeof c.name === 'string' && c.name.length > 0);
  }
});

test('indicators: all 24 slugs, each with a label/chartGroup/order and no unit field', async () => {
  const { indicators } = await get().json();
  assert.equal(indicators.length, 24);
  for (const i of indicators) {
    assert.ok(i.slug && i.label);
    assert.ok('chartGroup' in i);
    assert.ok('order' in i);
    // Unit varies by country for local-currency slugs (e.g. TT$ vs GY$), so it lives on each
    // series record, never deduped onto the indicator meta — see api/snapshot.ts's own comment.
    assert.ok(!('unit' in i), 'unit must live on the series record, not the indicator meta');
  }
});

test('series: every record carries the compact wire keys CE.* functions read positionally', async () => {
  const { series } = await get().json();
  assert.equal(series.length, 284, 'record count drifted — confirm this is an intentional data change');

  for (const s of series) {
    for (const key of ['c', 'i', 'u', 'src', 'org', 'tier', 'url', 'conf', 'p']) {
      assert.ok(key in s, `series record for ${s.c ?? '?'}/${s.i ?? '?'} is missing wire key "${key}"`);
    }
    assert.match(s.c, /^[A-Z]{2}$/);
    assert.ok(Array.isArray(s.p));
    for (const point of s.p) {
      assert.equal(point.length, 4, 'a wire point must be the [year, value, type, vintage] tuple');
      const [year, value, type, vintage] = point;
      assert.ok(Number.isInteger(year));
      assert.ok(value === null || typeof value === 'number');
      assert.ok(typeof type === 'string' && type.length > 0);
      assert.ok(typeof vintage === 'string' && vintage.length > 0);
    }
  }
});

test('point count across the whole snapshot matches the known hub total', async () => {
  const { series } = await get().json();
  const total = series.reduce((sum, s) => sum + s.p.length, 0);
  assert.equal(total, 2742, 'observation count drifted — confirm this is an intentional data change');
});

test('the payload is byte-identical across two calls — built once at cold start, not recomputed', async () => {
  const a = await get().text();
  const b = await get().text();
  assert.equal(a, b);
});

test('the version token changes only with vintage or record count, per the module comment', async () => {
  const { version, series } = await get().json();
  const maxVintage = series.flatMap(s => s.p.map(p => p[3])).sort().at(-1);
  assert.equal(version, `${maxVintage}:${series.length}`);
});
