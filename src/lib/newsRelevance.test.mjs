// Regression tests for the news relevance/classification rule (src/lib/newsRelevance.mjs).
// This module gates what reaches the site at both ingest (build-feeds.mjs) and render
// (dataHub.ts) — a bad regex edit here silently changes what readers see. Every case
// below pins a documented bug class from the session log or a known regex sharp edge
// (stems, lookaheads, word boundaries) so a future lexicon tweak can't reintroduce it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDisplayableNews, classifyNews } from './newsRelevance.mjs';

// [label, title, tags, expectedDisplayable]
const DISPLAYABLE_CASES = [
  // Documented bug: "Best Friend Remembers Cody Gomes" — a stray tag must never
  // drag in an off-topic tribute headline.
  ['tribute headline dropped', 'Best Friend Remembers Cody Gomes', [], false],
  // Documented bug: "Pensioner found dead in car" — pension is an include term but
  // not strong, so a death word must still drop it.
  ['death word beats weak include term', 'Pensioner found dead in car', [], false],
  // The real pension story the fix above must not collaterally kill.
  ['genuine pension story survives', 'Government increases pension payments for seniors', [], true],
  // "passing" is deliberately excluded from EXCLUDE_RE because it collides with
  // "passing" a budget/legislation — must not regress into an exclude term.
  ['budget "passing" is not a death euphemism', 'Passing of the 2026 budget marks a milestone', [], true],
  ['human "passing" tribute still dropped', 'Beloved teacher passing mourned by students', [], false],
  // Court/crime exclusion rescued only by a genuinely strong economic term.
  ['court story rescued by strong economic term', 'Court rules on taxation dispute involving major firm', [], true],
  ['bank robbery not rescued (bank/robbery both weak)', 'Man charged after robbery at downtown bank', [], false],
  // Stem/lookahead false-positive guards.
  ['"important" does not match import(?!ant)', 'This is an important announcement for the community', [], false],
  ['"investigation" does not match invest(?!igat)', 'New investigation launched into corruption claims', [], false],
  ['"portfolio" does not match \\bports?\\b', 'Portfolio review board meets Thursday', [], false],
  // Tag-only economic signal must never rescue an off-topic title (the general
  // form of the "Best Friend Remembers" bug — classification is title-driven).
  ['tag-only signal does not rescue off-topic title', 'Local school wins regional debate contest', ['business'], false],
  // Plainly off-topic, no signal anywhere.
  ['no economic signal at all', 'Community garden opens downtown', [], false],
  ['sport is dropped', 'Local team wins football championship', [], false],
  ['entertainment is dropped', 'Trinidad Carnival 2026 dates announced', [], false],
  // Core economic stories must keep working.
  ['central bank rate story', 'Central bank raises interest rate to curb inflation', [], true],
  ['budget tabling', 'Government tables 2026 budget in parliament', [], true],
  ['IMF growth forecast', 'IMF forecasts growth for Guyana', [], true],
];

test('isDisplayableNews: documented bug classes and core cases', () => {
  for (const [label, title, tags, expected] of DISPLAYABLE_CASES) {
    assert.equal(isDisplayableNews(title, tags), expected, `${label} — "${title}"`);
  }
});

// [label, title, expectedCategory, expectedConfidence]
const CLASSIFY_CASES = [
  ['IMF term routes to Debt, not a generic bucket', 'IMF forecasts growth for Guyana', 'Debt', 'high'],
  ['central bank + inflation routes to Inflation (first-match-wins order)', 'Central bank raises interest rate to curb inflation', 'Inflation', 'high'],
  // "World Bank" / "development bank" are multilateral finance, not retail banking —
  // the Banking rule's negative lookbehind must keep excluding them.
  ['World Bank does not classify as retail Banking', 'World Bank report highlights regional growth', 'Macro', 'medium'],
  ['development bank does not classify as retail Banking', 'Development bank funds new housing project', 'Infrastructure', 'high'],
  ['off-topic title is Unclassified/low, never a confident chip', 'Best Friend Remembers Cody Gomes', 'Unclassified', 'low'],
];

test('classifyNews: category + confidence pinning', () => {
  for (const [label, title, expectedCategory, expectedConfidence] of CLASSIFY_CASES) {
    const { category, confidence } = classifyNews(title);
    assert.equal(category, expectedCategory, `${label} — category`);
    assert.equal(confidence, expectedConfidence, `${label} — confidence`);
  }
});
