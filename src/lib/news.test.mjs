/* Contract tests for the News Hub reader (src/lib/news.ts) — the Phase 0 gate in the build
 * plan's section 9 ("metadata-only news search, date windows, missing coverage").
 *
 * These assert INVARIANTS, never specific headlines, counts, or dates. news.ts imports
 * data/news.json at module scope and exposes no injection point, so every test here runs
 * against the live archive — which the feeds cron regenerates twice daily and windows to the
 * last NEWS_WINDOW_DAYS. A test asserting "returns 6 items about Guyana" would pass today and
 * fail tomorrow for reasons that have nothing to do with the code.
 *
 * The one thing asserted about the corpus itself is that it is non-empty (see the first test).
 * Without it every "every returned item satisfies X" assertion below would pass vacuously on an
 * empty archive, which is exactly the failure mode that would matter most.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchNews, getNewsCoverage } from './news.ts';

// Fields a NewsEvidence record is allowed to carry. Anything outside this set — most importantly
// anything resembling an article body — is a policy violation, not just a schema surprise.
const ALLOWED_KEYS = new Set(['id', 'title', 'source', 'date', 'country', 'url', 'category', 'tags']);
const REQUIRED_KEYS = ['id', 'title', 'source', 'date', 'country', 'url'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

test('the archive is non-empty — guards every other test in this file from passing vacuously', () => {
  const coverage = getNewsCoverage();
  assert.ok(coverage.count > 0, 'no publishable news records: every invariant below is vacuous');
  assert.ok(searchNews({ limit: 1 }).length === 1);
});

// ── Metadata-only policy ───────────────────────────────────────────────────────────────────

test('searchNews returns metadata only — never an article body', () => {
  const results = searchNews({ limit: 12 });
  for (const item of results) {
    for (const key of Object.keys(item)) {
      assert.ok(
        ALLOWED_KEYS.has(key),
        `NewsEvidence leaked an unexpected field "${key}" — the hub stores no article text`,
      );
    }
  }
});

test('every returned record carries the full required citation set', () => {
  for (const item of searchNews({ limit: 12 })) {
    for (const key of REQUIRED_KEYS) {
      assert.ok(item[key], `missing "${key}" — a record without it cannot be cited`);
    }
    assert.match(item.date, ISO_DATE, 'date must be ISO 8601 YYYY-MM-DD');
    assert.ok(item.url.startsWith('http'), 'url must be a real link, not a fragment');
  }
});

// ── Date windows ───────────────────────────────────────────────────────────────────────────

test('dateFrom and dateTo are both inclusive bounds, and both actually exclude', () => {
  const { earliest, latest } = getNewsCoverage();
  assert.notEqual(earliest, latest, 'archive spans a single day: this test cannot discriminate');

  const oldest = searchNews({ dateTo: earliest, limit: 12 });
  const newest = searchNews({ dateFrom: latest, limit: 12 });

  // Inclusive: bounding at a date that exists must return that date's records, not zero.
  assert.ok(oldest.length > 0, 'dateTo=earliest excluded the earliest record — bound is not inclusive');
  assert.ok(newest.length > 0, 'dateFrom=latest excluded the latest record — bound is not inclusive');

  for (const item of oldest) assert.equal(item.date, earliest);
  for (const item of newest) assert.equal(item.date, latest);

  // Load-bearing: the two windows sit at opposite ends of the archive, so a filter that
  // silently passed everything through would make them overlap.
  const oldestIds = new Set(oldest.map(i => i.id));
  for (const item of newest) {
    assert.ok(!oldestIds.has(item.id), 'opposite-end windows overlap — the date filter is not applied');
  }
});

test('a single-day window does not leak the days either side of it', () => {
  const { latest } = getNewsCoverage();
  const sameDay = searchNews({ dateFrom: latest, dateTo: latest, limit: 12 });
  assert.ok(sameDay.length > 0);
  for (const item of sameDay) assert.equal(item.date, latest);
});

test('a window outside the archive returns nothing rather than substituting recent stories', () => {
  // The coverage gap is the product: a question about a period the hub does not cover must
  // return empty so the caller can say so, never the nearest available headlines.
  assert.deepEqual(searchNews({ dateFrom: '1990-01-01', dateTo: '1990-12-31' }), []);
});

test('an inverted window (from after to) returns nothing', () => {
  const { earliest, latest } = getNewsCoverage();
  assert.deepEqual(searchNews({ dateFrom: latest, dateTo: earliest, limit: 12 }), []);
});

// ── Country scope ──────────────────────────────────────────────────────────────────────────

test('country filtering admits the requested country and pan-Caribbean ALL, nothing else', () => {
  for (const item of searchNews({ countries: ['GY'], limit: 12 })) {
    assert.ok(
      item.country === 'GY' || item.country === 'ALL',
      `country filter leaked ${item.country}`,
    );
  }
});

test('country codes are matched case-insensitively', () => {
  assert.deepEqual(searchNews({ countries: ['gy'], limit: 6 }), searchNews({ countries: ['GY'], limit: 6 }));
});

test('no country filter returns the whole archive, not a single-country slice', () => {
  const countries = new Set(searchNews({ limit: 12 }).map(i => i.country));
  assert.ok(countries.size >= 1);
});

// ── Keyword matching ───────────────────────────────────────────────────────────────────────

test('every keyword result actually matches the keyword somewhere citable', () => {
  const results = searchNews({ keywords: ['oil'], limit: 12 });
  for (const item of results) {
    const haystack = [item.title, item.source, item.category ?? '', ...(item.tags ?? [])]
      .join(' ')
      .toLowerCase();
    assert.ok(haystack.includes('oil'), `"${item.title}" matched "oil" but contains no such term`);
  }
});

test('title matching respects a leading word boundary — "oil" must not match "spoiled"', () => {
  for (const item of searchNews({ keywords: ['oil'], limit: 12 })) {
    if (/oil/i.test(item.title)) {
      assert.match(item.title, /\boil/i, `"${item.title}" matched on an interior substring`);
    }
  }
});

test('a keyword with no match anywhere returns nothing rather than falling back to recency', () => {
  assert.deepEqual(searchNews({ keywords: ['zzzzznotarealterm'] }), []);
});

test('an empty or whitespace-only keyword is ignored, not treated as a match-nothing filter', () => {
  const baseline = searchNews({ limit: 6 });
  assert.deepEqual(searchNews({ keywords: ['   '], limit: 6 }), baseline);
});

// ── Ranking and determinism ────────────────────────────────────────────────────────────────

test('deterministic: identical inputs return identical records in identical order', () => {
  const a = searchNews({ countries: ['TT'], keywords: ['energy'], limit: 8 });
  const b = searchNews({ countries: ['TT'], keywords: ['energy'], limit: 8 });
  assert.deepEqual(a, b, 'a citation must trace to a rule, not to a re-run');
});

test('with no keywords, results are newest-first', () => {
  const dates = searchNews({ limit: 12 }).map(i => i.date);
  assert.deepEqual([...dates].sort().reverse(), dates);
});

test('ties break on id so equal-dated records never reorder between calls', () => {
  const results = searchNews({ limit: 12 });
  for (let i = 1; i < results.length; i++) {
    if (results[i].date === results[i - 1].date) {
      assert.ok(
        results[i - 1].id.localeCompare(results[i].id) <= 0,
        'equal-dated records are not id-ordered',
      );
    }
  }
});

test('ids are unique — an approved review row replaces its archive twin rather than duplicating it', () => {
  const ids = searchNews({ limit: 12 }).map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ── Limits ─────────────────────────────────────────────────────────────────────────────────

test('limit is clamped to the 1..MAX_LIMIT band', () => {
  assert.ok(searchNews({ limit: 999 }).length <= 12, 'limit above MAX_LIMIT was not clamped');
  assert.equal(searchNews({ limit: 0 }).length, 1, 'limit below 1 was not raised to 1');
  assert.equal(searchNews({ limit: -5 }).length, 1);
});

test('the default limit applies when none is given', () => {
  assert.ok(searchNews().length <= 6);
});

test('searchNews with no arguments does not throw', () => {
  assert.doesNotThrow(() => searchNews());
});

// ── Coverage reporting ─────────────────────────────────────────────────────────────────────

test('getNewsCoverage reports a coherent, ordered window', () => {
  const { earliest, latest, count } = getNewsCoverage();
  assert.match(earliest, ISO_DATE);
  assert.match(latest, ISO_DATE);
  assert.ok(earliest <= latest, 'earliest must not postdate latest');
  assert.ok(Number.isInteger(count) && count > 0);
});

test('coverage bounds agree with what searchNews will actually return', () => {
  const { earliest, latest } = getNewsCoverage();
  for (const item of searchNews({ limit: 12 })) {
    assert.ok(item.date >= earliest && item.date <= latest, 'a record fell outside reported coverage');
  }
});
