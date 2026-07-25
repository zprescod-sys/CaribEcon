// Regression tests for the shared news search/pagination logic (src/lib/newsSearch.ts).
// This module was extracted from NewsFeed.astro's client <script> (previously
// untestable inline code) as part of moving search off the fully-rendered-archive
// model onto a fetched news-index.json — these tests pin that the extraction changed
// nothing about matching behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, splitTerms, matchesTerms, resolveCategoryGroup } from './newsSearch.ts';

test('normalize: "T&T" / "T & T" / "T and T" / "t and t" all fold to the same haystack prefix', () => {
  // Bare "tt" (no & / and separator) is deliberately NOT one of these — the
  // regex only fires between two "t" tokens joined by "&" or "and".
  const variants = ['T&T', 'T & T', 'T and T', 't and t'];
  const normalized = variants.map(normalize);
  for (const n of normalized) {
    assert.ok(n.includes('trinidad tobago'), `"${n}" should contain "trinidad tobago"`);
  }
});

test('normalize: diacritics fold (Curacao search term matches Curaçao text)', () => {
  const haystack = normalize('Curaçao budget deficit narrows');
  const query = normalize('curacao');
  assert.ok(haystack.includes(query));
});

test('normalize: a literal "&" becomes "and", not dropped', () => {
  assert.equal(normalize('Bed & Breakfast'), 'bed and breakfast');
});

test('normalize: punctuation collapses to single spaces, case folds', () => {
  assert.equal(normalize('  Guyana:  GDP--Growth!! '), 'guyana gdp growth');
});

test('splitTerms + matchesTerms: multi-term AND semantics, "and" itself is not a term', () => {
  const haystack = normalize('Guyana GDP growth accelerates in 2026');
  const terms = splitTerms(normalize('guyana and growth'));
  assert.deepEqual(terms, ['guyana', 'growth']);
  assert.equal(matchesTerms(haystack, terms), true);

  // A term that isn't present must fail the AND, even though other terms match.
  const missingTerm = splitTerms(normalize('guyana inflation'));
  assert.equal(matchesTerms(haystack, missingTerm), false);
});

test('resolveCategoryGroup: a human categoryOverride wins over everything else', () => {
  const { category, group } = resolveCategoryGroup({
    categoryOverride: 'Energy',
    groupOverride: 'Energy',
    category: 'Tourism',
    group: 'Trade & Tourism',
    title: 'Slingerz FC cruise into CFU Club Shield Round of 16',
    tags: ['sports'],
  });
  assert.equal(category, 'Energy');
  assert.equal(group, 'Energy');
});

test('resolveCategoryGroup: a stored classifier decision is trusted over a fresh re-derivation', () => {
  const { category, group } = resolveCategoryGroup({
    category: 'Government',
    group: 'Macro',
    title: 'Whatever title, should not matter here',
    tags: [],
  });
  assert.equal(category, 'Government');
  assert.equal(group, 'Macro');
});

test('resolveCategoryGroup: a legacy record with neither falls through to classifyNews()', () => {
  const { category, group } = resolveCategoryGroup({
    title: 'Central bank raises interest rate to curb inflation',
    tags: [],
  });
  assert.equal(category, 'Inflation');
  assert.equal(group, 'Macro');
});
