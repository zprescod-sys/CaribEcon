// Regression tests for the Deep Dive / Comparison picker validator (src/lib/excelIntent.ts).
// Real hub country codes/slugs (GY, TT, gdp_growth, inflation) — same fixtures used
// throughout askTools.ts and the CE.* function reference, so a hub edit that breaks these
// breaks the rest of the add-in too, not just this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSingleCountryPicker, validateComparisonPicker } from './excelIntent.ts';

test('validateSingleCountryPicker: valid picker input resolves to a full intent', () => {
  const { intent, misses } = validateSingleCountryPicker({
    countries: ['GY'],
    indicators: ['gdp_growth', 'inflation'],
    yearFrom: 2020,
    yearTo: 2025,
  });
  assert.equal(misses.length, 0);
  assert.deepEqual(intent, {
    workflow: 'single_country',
    country: 'GY',
    indicators: ['gdp_growth', 'inflation'],
    yearFrom: 2020,
    yearTo: 2025,
    outputs: { table: true, charts: true, explanation: false },
  });
});

test('validateSingleCountryPicker: zero countries is a miss, not a silent no-op', () => {
  const { intent, misses } = validateSingleCountryPicker({ countries: [], indicators: ['gdp_growth'] });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'country'));
});

test('validateSingleCountryPicker: two countries is a miss for this workflow, never narrowed to the first', () => {
  const { intent, misses } = validateSingleCountryPicker({
    countries: ['GY', 'TT'],
    indicators: ['gdp_growth'],
  });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'country' && m.detail.includes('exactly one')));
});

test('validateSingleCountryPicker: an unresolvable country code is reported, never guessed', () => {
  const { intent, misses } = validateSingleCountryPicker({ countries: ['ZZ'], indicators: ['gdp_growth'] });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'country' && m.detail.includes('ZZ')));
});

test('validateSingleCountryPicker: an unresolvable indicator is dropped and reported, valid ones kept', () => {
  const { intent, misses } = validateSingleCountryPicker({
    countries: ['GY'],
    indicators: ['gdp_growth', 'not_a_real_slug'],
  });
  assert.deepEqual(intent.indicators, ['gdp_growth']);
  assert.ok(misses.some(m => m.kind === 'indicator' && m.detail.includes('not_a_real_slug')));
});

test('validateSingleCountryPicker: no indicators at all is a miss', () => {
  const { intent, misses } = validateSingleCountryPicker({ countries: ['GY'], indicators: [] });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'indicator'));
});

test('validateSingleCountryPicker: more than 3 indicators is trimmed to the first 3', () => {
  const { intent } = validateSingleCountryPicker({
    countries: ['GY'],
    indicators: ['gdp_growth', 'inflation', 'unemployment', 'fiscal_balance'],
  });
  assert.equal(intent.indicators.length, 3);
});

test('validateSingleCountryPicker: explanation output is always forced false regardless of request', () => {
  const { intent } = validateSingleCountryPicker({
    countries: ['GY'],
    indicators: ['gdp_growth'],
    outputs: { explanation: true },
  });
  assert.equal(intent.outputs.explanation, false);
});

test('validateComparisonPicker: valid picker input resolves to a full intent', () => {
  const { intent, misses } = validateComparisonPicker({
    countries: ['TT', 'GY'],
    indicators: ['inflation'],
    yearFrom: 2022,
    yearTo: 2025,
  });
  assert.equal(misses.length, 0);
  assert.deepEqual(intent, {
    workflow: 'comparison',
    countries: ['TT', 'GY'],
    indicators: ['inflation'],
    yearFrom: 2022,
    yearTo: 2025,
    outputs: { table: true, charts: true, explanation: false },
  });
});

test('validateComparisonPicker: one country is a miss, never silently expanded to all 19 economies', () => {
  const { intent, misses } = validateComparisonPicker({ countries: ['GY'], indicators: ['inflation'] });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'country' && m.detail.includes('at least two')));
});

test('validateComparisonPicker: zero countries is a miss', () => {
  const { intent, misses } = validateComparisonPicker({ countries: [], indicators: ['inflation'] });
  assert.equal(intent, null);
  assert.ok(misses.some(m => m.kind === 'country'));
});

test('validateComparisonPicker: a duplicate country code is deduplicated, not counted twice', () => {
  const { intent, misses } = validateComparisonPicker({
    countries: ['GY', 'GY', 'TT'],
    indicators: ['inflation'],
  });
  assert.deepEqual(intent.countries, ['GY', 'TT']);
  assert.equal(misses.length, 0);
});

test('validateComparisonPicker: one resolvable + one unresolvable country reports the miss and still needs a second real economy', () => {
  const { intent, misses } = validateComparisonPicker({ countries: ['GY', 'ZZ'], indicators: ['inflation'] });
  assert.equal(intent, null); // only one real country resolved — still below the 2-country floor
  assert.ok(misses.some(m => m.kind === 'country' && m.detail.includes('ZZ')));
  assert.ok(misses.some(m => m.detail.includes('at least two')));
});
