// Regression tests for the deterministic calculation registry (src/lib/calculations.ts).
// Every case here pins a rule from the plan (§5, §6): a calculation never guesses across a
// gap, never divides by zero, and never lets a null point masquerade as a zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yoy_change, period_average, CALCULATION_REGISTRY } from './calculations.ts';

const point = (year, value, type = 'actual') => ({ year, value, type });

test('yoy_change: standard consecutive-year percentage change', () => {
  const result = yoy_change([point(2022, 100), point(2023, 110)]);
  assert.deepEqual(result, [
    { year: 2022, value: null, inputYears: [2022] },
    { year: 2023, value: 10, inputYears: [2022, 2023] },
  ]);
});

test('yoy_change: negative change computes correctly', () => {
  const result = yoy_change([point(2022, 100), point(2023, 90)]);
  assert.equal(result[1].value, -10);
});

test('yoy_change: never interpolates across a missing year', () => {
  // 2022 is absent entirely — 2024 must not be diffed against 2023 as if 2022 didn't matter,
  // and it must not be diffed against a synthesized zero either.
  const result = yoy_change([point(2023, 100), point(2024, 110)]);
  assert.deepEqual(result[0], { year: 2023, value: null, inputYears: [2023] });
  assert.equal(result[1].value, 10); // 2023 -> 2024 is a real consecutive pair
});

test('yoy_change: a gap year (present but null value) blocks the calculation both sides', () => {
  const result = yoy_change([point(2022, 100), point(2023, null), point(2024, 121)]);
  assert.equal(result[1].value, null); // 2023 itself has no value
  assert.equal(result[2].value, null); // 2024 has no valid prior (2023 is null)
});

test('yoy_change: zero-valued prior year refuses to divide by zero', () => {
  const result = yoy_change([point(2022, 0), point(2023, 50)]);
  assert.equal(result[1].value, null);
});

test('yoy_change: unsorted input still resolves years in order', () => {
  const result = yoy_change([point(2024, 121), point(2022, 100), point(2023, 110)]);
  assert.deepEqual(result.map(r => r.year), [2022, 2023, 2024]);
  assert.equal(result[2].value, 10); // 2023 -> 2024
});

test('period_average: excludes null points from both sum and count', () => {
  const result = period_average([point(2022, 100), point(2023, null), point(2024, 200)]);
  assert.equal(result.value, 150); // (100 + 200) / 2, not / 3
  assert.equal(result.year, 2024); // stamped on the latest year actually used
  assert.deepEqual(result.inputYears, [2022, 2024]);
});

test('period_average: single point returns that point\'s value', () => {
  const result = period_average([point(2024, 42)]);
  assert.equal(result.value, 42);
});

test('period_average: all-null input returns a null result, not NaN or zero', () => {
  const result = period_average([point(2022, null), point(2023, null)]);
  assert.equal(result.value, null);
  assert.deepEqual(result.inputYears, []);
});

test('CALCULATION_REGISTRY exposes both functions by their plan-facing name', () => {
  assert.equal(CALCULATION_REGISTRY.yoy_change, yoy_change);
  assert.equal(CALCULATION_REGISTRY.period_average, period_average);
});
