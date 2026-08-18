/* Tests for the grounding gate (src/lib/ai/grounding.ts), Phase 2 / check 1 (ref existence).
 *
 * No mocks — same standing policy as the other src/lib/ai tests. Run against the real captures
 * in fixtures/askCaptures.json (real model output from real Nebius/MiniMax calls, Phase 1 item
 * 7), not hand-built ResearchAnswer objects, so this exercises the gate against what the
 * pipeline actually produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runGroundingGate, figureMatches } from './grounding.ts';
import { buildEvidencePackage } from '../askTools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const captures = JSON.parse(readFileSync(join(__dirname, 'fixtures/askCaptures.json'), 'utf8'));

// Phase 1 captures that failed before synthesis (parse errors, timeouts) have result: null —
// there is no ResearchAnswer to gate. Only real answer/evidence pairs are usable here.
const usable = captures.filter(c => c.result !== null);
assert.ok(usable.length >= 5, 'expected several usable real captures to test against');

// These real captures each state a figure never actually backed by a declared StatedFigure.
// check 6 (unstated_number) correctly flags each: a genuine, expected grounding gap — proof the
// gate works, not a false positive to paper over.
//
//   "regional" claim-6 (type: 'context'): states a figure sourced from an institution (Central
//   Bank of Barbados / Central Bank of The Bahamas) that this pipeline never actually retrieved
//   — only the IMF figure was retrieved and declared as a StatedFigure: "...Central Bank of
//   Barbados reports a higher gross-debt ratio (e.g. 103% vs IMF 98.9%)... Central Bank of The
//   Bahamas reports 81.5% vs IMF 73.8%." — 103 and 81.5 are never declared anywhere in the
//   answer; only 98.9 and 73.8 are.
//
//   "multi_country_comparison" claim-5 (type: 'context'): same Central-Bank-vs-IMF pattern:
//   "...the Central Bank of Barbados reports a higher gross-debt ratio (e.g. 103% for 2024 vs
//   IMF 98.9%)..." — 103 is never declared.
//
//   "research_question" claim-5 (type: 'figure'): "...rates were flat (0.00%) in every other
//   year reported (D:GY:fx_rate_usd)." — true of the retrieved series (every year besides the two
//   explicitly declared, 2018 and 2019, really is a flat 0.00% yoy change), but "every other
//   year" names no specific year and 0.00 is never declared as its own StatedFigure — exactly the
//   kind of loosely-stated aggregate check 6 exists to force a model to declare structurally
//   rather than assert in prose, true or not (see this module's header: it checks what the
//   answer asserts against what evidence explicitly backs, not whether the assertion happens to
//   be correct). Before the fix to checkUnstatedNumber's small-count exemption, this ALSO relied
//   on the exact same fabrication-shaped hole flagged by adversarial review (Number.isInteger on
//   a parsed "0.00" collapses to whole-number 0, wrongly landing in the 0-30 "small narrative
//   count" range) — closing that hole for the fabricated repro cases necessarily closes it here
//   too, so this capture's expected result correctly moved from zero violations to one.
const KNOWN_EXPECTED_VIOLATIONS = {
  regional: [
    { claimId: 'claim-6', check: 'unstated_number' },
    { claimId: 'claim-6', check: 'unstated_number' },
  ],
  multi_country_comparison: [{ claimId: 'claim-5', check: 'unstated_number' }],
  research_question: [{ claimId: 'claim-5', check: 'unstated_number' }],
};

// Checks 9 (cross_currency_comparison) and 10 (coverage_honesty) add zero violations across
// every usable real capture (verified) — none of the KNOWN_EXPECTED_VIOLATIONS entries above
// change with either check active.
test('every real captured answer passes cleanly across all nine active checks — except three known, expected unstated_number gaps', () => {
  for (const capture of usable) {
    const { answer, evidence } = capture.result;
    const result = runGroundingGate(answer, evidence);
    assert.equal(result.ran, true);
    const expected = KNOWN_EXPECTED_VIOLATIONS[capture.category] ?? [];
    const actual = result.violations.map(v => ({ claimId: v.claimId, check: v.check }));
    assert.deepEqual(
      actual,
      expected,
      `expected violations ${JSON.stringify(expected)} for capture "${capture.category}", got: ${JSON.stringify(result.violations)}`,
    );
  }
});

test('a claim citing a ref absent from evidenceMeta is flagged', () => {
  const withRealRefs = usable.find(c => c.result.evidence.evidenceMeta.length > 0);
  const { evidence } = withRealRefs.result;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: 'x', type: 'figure', refs: ['D:XX:not_a_real_series'], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].claimId, 'claim-0');
  assert.equal(result.violations[0].check, 'ref_existence');
  assert.match(result.violations[0].detail, /D:XX:not_a_real_series/);
});

test('the same bad ref cited in both claim.refs and a figure is reported once, not twice', () => {
  const withRealRefs = usable.find(c => c.result.evidence.evidenceMeta.length > 0);
  const { evidence } = withRealRefs.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:XX:not_a_real_series'],
      figures: [{ ref: 'D:XX:not_a_real_series', year: 2024, value: 1, unit: '%', calculation: null, asWritten: '1%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.length, 1);
});

test('a "framing" claim with no refs at all produces no ref-existence violation', () => {
  const withRealRefs = usable.find(c => c.result.evidence.evidenceMeta.length > 0);
  const { evidence } = withRealRefs.result;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: 'general commentary', type: 'framing', refs: [], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations, []);
});

// ── Check 2: URL allowlist ──────────────────────────────────────────────────────────────────

test('a claim stating a URL not among the retrieved sources is flagged', () => {
  const withRealRefs = usable.find(c => c.result.evidence.evidenceMeta.length > 0);
  const { evidence } = withRealRefs.result;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: 'See https://example.com/made-up-report for details.', type: 'context', refs: [], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const urlViolations = result.violations.filter(v => v.check === 'url_allowlist');
  assert.equal(urlViolations.length, 1);
  assert.equal(urlViolations[0].claimId, 'claim-0');
  assert.match(urlViolations[0].detail, /example\.com\/made-up-report/);
});

test('a claim stating a real retrieved sourceUrl verbatim passes', () => {
  const capture = usable.find(c => c.result.evidence.data.length > 0);
  const { evidence } = capture.result;
  const realUrl = evidence.data[0].sourceUrl;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: `Source: ${realUrl}.`, type: 'context', refs: [], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'url_allowlist'), []);
});

test('URL normalisation: trailing slash, host case, and utm_* params do not cause a false mismatch', () => {
  const capture = usable.find(c => c.result.evidence.data.length > 0);
  const { evidence } = capture.result;
  const realUrl = new URL(evidence.data[0].sourceUrl);
  const decorated = `${realUrl.protocol}//${realUrl.hostname.toUpperCase()}${realUrl.pathname}/${realUrl.search ? `${realUrl.search}&` : '?'}utm_source=newsletter`;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: `Source: ${decorated}`, type: 'context', refs: [], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'url_allowlist'), []);
});

test('a real domain with a fabricated path still fails — the check is exact-URL, not domain-only', () => {
  const capture = usable.find(c => c.result.evidence.data.length > 0);
  const { evidence } = capture.result;
  const realUrl = new URL(evidence.data[0].sourceUrl);
  const fabricatedPath = `${realUrl.protocol}//${realUrl.hostname}/totally/made/up/path`;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: `Source: ${fabricatedPath}`, type: 'context', refs: [], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.filter(v => v.check === 'url_allowlist').length, 1);
});

// ── Check 3: slug / country tokens ──────────────────────────────────────────────────────────

test('a non-framing claim naming a country that was not retrieved is flagged (and "and" is recognised, not just "&")', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // retrieved: GY only
  const { evidence } = capture.result;
  const validRef = evidence.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: "This is well above Trinidad and Tobago's comparable figure.",
      type: 'context',
      refs: [validRef],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'slug_tokens');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /\(TT\)/);
});

test('a non-framing claim naming an indicator slug that was not retrieved is flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // retrieved: gdp_growth only
  const { evidence } = capture.result;
  const validRef = evidence.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Unemployment also rose over the same period.',
      type: 'trend',
      refs: [validRef],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'slug_tokens');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /unemployment/);
});

test('a framing claim honestly naming an absence of data is exempt — a real capture does exactly this', () => {
  const capture = usable.find(c => c.category === 'out_of_hub_country');
  const result = runGroundingGate(capture.result.answer, capture.result.evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'slug_tokens'), []);
});

test('a bare 2-letter country code is never scanned — too noisy, per §2.6', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // retrieved: GY only
  const { evidence } = capture.result;
  const validRef = evidence.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  const answer = {
    headline: 'x',
    claims: [{ id: 'claim-0', text: 'TT and BB were not part of this query.', type: 'context', refs: [validRef], figures: [] }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'slug_tokens'), []);
});

// ── Check 4: figure reconciliation ──────────────────────────────────────────────────────────

test('a raw figure (calculation: null) with the wrong value is flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, 2024 = 43.82
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: 2024, value: 99.9, unit: '%', calculation: null, asWritten: '99.9' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /43\.82/);
});

test('a raw figure at a year with no retrieved point is flagged, not silently skipped', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // only has a 2024 point
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: 2019, value: 5, unit: '%', calculation: null, asWritten: '5' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /no retrieved value/);
});

test('a period_average figure with the wrong value is flagged (year is ignored, per synthesize.ts convention)', () => {
  const capture = usable.find(c => c.category === 'simple_factual');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: null, value: 10, unit: '%', calculation: 'period_average', asWritten: '10' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /43\.82/);
});

test('a pp_change figure that does not match re-running the registry function is flagged', () => {
  const capture = usable.find(c => c.category === 'time_series'); // D:JM:inflation: 2020=5.23, 2021=5.86 -> pp_change 0.63
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      figures: [{ ref: 'D:JM:inflation', year: 2021, value: 5.0, unit: 'pp', calculation: 'pp_change', asWritten: '5.0' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'figure_reconciliation');
  assert.equal(violations.length, 1);
  // The real subtraction is 5.86 - 5.23, which lands on 0.6299999999999999 in floating point —
  // the detail message must read as a clean 0.63, not surface that binary noise.
  assert.match(violations[0].detail, /gives 0\.63\./);
  assert.match(violations[0].detail, /2020, 2021/); // inputYears surfaced for lineage
});

test('a calculated figure at a year the registry function cannot produce (no prior-year point) is flagged', () => {
  const capture = usable.find(c => c.category === 'time_series');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      // 2020 is the series' first year — no 2019 point exists, so pp_change there is null.
      figures: [{ ref: 'D:JM:inflation', year: 2020, value: 1, unit: 'pp', calculation: 'pp_change', asWritten: '1' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /produces no value/);
});

test('a figure whose ref does not resolve at all is left to check 1, not double-reported by check 4', () => {
  const capture = usable.find(c => c.category === 'simple_factual');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:XX:not_real'],
      figures: [{ ref: 'D:XX:not_real', year: 2024, value: 1, unit: '%', calculation: null, asWritten: '1' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.filter(v => v.check === 'figure_reconciliation').length, 0);
  assert.equal(result.violations.filter(v => v.check === 'ref_existence').length, 1);
});

// ── Check 5: wrong calculation ──────────────────────────────────────────────────────────────

test('a %-unit series claimed as yoy_change is flagged — pp_change is what its unit requires', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, unit "%"
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: 2024, value: 1.5, unit: '%', calculation: 'yoy_change', asWritten: '1.5' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'wrong_calculation');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /yoy_change/);
  assert.match(violations[0].detail, /requires pp_change/);
});

test('the correct calculation for a %-unit series (pp_change) is not flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, unit "%"
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: 2024, value: 1.5, unit: '%', calculation: 'pp_change', asWritten: '1.5' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'wrong_calculation'), []);
});

test('period_average is never flagged by wrong_calculation, regardless of unit', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, unit "%"
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:GY:gdp_growth'],
      figures: [{ ref: 'D:GY:gdp_growth', year: null, value: 43.82, unit: '%', calculation: 'period_average', asWritten: '43.82' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'wrong_calculation'), []);
});

test('a figure whose ref does not resolve at all produces no wrong_calculation violation — left to check 1', () => {
  const capture = usable.find(c => c.category === 'simple_factual');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:XX:not_real'],
      figures: [{ ref: 'D:XX:not_real', year: 2024, value: 1, unit: '%', calculation: 'yoy_change', asWritten: '1' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.filter(v => v.check === 'wrong_calculation').length, 0);
  assert.equal(result.violations.filter(v => v.check === 'ref_existence').length, 1);
});

// ── Check 6: unstated number ─────────────────────────────────────────────────────────────────

test('a non-framing claim stating a number with no matching declared figure is flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, 2024 = 43.82
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'GDP growth reached an unprecedented 250.7% in 2024.',
      type: 'context',
      refs: ['D:GY:gdp_growth'],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'unstated_number');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /250\.7/);
});

test('a framing claim stating arbitrary numbers is never flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Across the 19 economies, roughly 837.2 things were mentioned in 1955.',
      type: 'framing',
      refs: [],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'unstated_number'), []);
});

test('a claim reusing a figure declared in a DIFFERENT claim of the same answer is not flagged (cross-claim pool)', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth, 2024 = 43.82
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'GDP growth reached 43.82% in 2024.',
        type: 'figure',
        refs: ['D:GY:gdp_growth'],
        figures: [{ ref: 'D:GY:gdp_growth', year: 2024, value: 43.82, unit: '%', calculation: null, asWritten: '43.82' }],
      },
      {
        id: 'claim-1',
        text: 'That 43.82% figure from 2024 stands out in the region.',
        type: 'context',
        refs: ['D:GY:gdp_growth'],
        figures: [], // not re-declared here — reuses claim-0's figure, a narrative callback
      },
    ],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'unstated_number'), []);
});

test('a claim stating a small count like "2" or "19" with no matching declared figure is not flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'This covers 19 economies over 2 consecutive years, with the top 3 economies leading.',
      type: 'context',
      refs: ['D:GY:gdp_growth'],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'unstated_number'), []);
});

test('a claim naming a real retrieved point-year with no matching declared figure is not flagged', () => {
  const capture = usable.find(c => c.category === 'simple_factual'); // D:GY:gdp_growth has a 2024 point
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The most recent reading is from 2024.',
      type: 'context',
      refs: ['D:GY:gdp_growth'],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'unstated_number'), []);
});

test('a sign-mismatched number ("declining 3.88" vs a declared figure of -3.88) is not flagged', () => {
  const capture = usable.find(c => c.category === 'time_series'); // D:JM:inflation
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Inflation fell, declining 3.88 pp over the year.',
      type: 'trend',
      refs: ['D:JM:inflation'],
      figures: [{ ref: 'D:JM:inflation', year: 2023, value: -3.88, unit: 'pp', calculation: 'pp_change', asWritten: '-3.88' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'unstated_number'), []);
});

// ── Check 7: news body claim ────────────────────────────────────────────────────────────────

// None of the 9 usable real captures include any news evidence at all — every capture's
// evidence.news array is empty (verified by inspecting fixtures/askCaptures.json directly), so
// this check cannot be exercised against a real captured ResearchAnswer the way checks 1-6 are
// above. What IS real here, per this repo's no-mocks policy for src/lib/ai tests, is the evidence
// package: buildEvidencePackage is the real, unmocked retrieval facade, called with a real intent
// (questionType: 'news', an indicator too, so ONE package carries both a real D: ref and real N:
// refs pulled live out of data/news.json) — only the ResearchAnswer/claims below are hand-built,
// because no real capture happens to produce a news-only claim to test against.
const NEWS_TEST_RETRIEVED_AT = '2026-08-17T00:00:00.000Z';
const newsPkg = buildEvidencePackage(
  { questionType: 'news', countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null, newsKeywords: [] },
  NEWS_TEST_RETRIEVED_AT,
);
assert.ok(newsPkg.news.length > 0, 'expected real News Hub coverage for GY to exercise check 7');
assert.ok(newsPkg.data.length > 0, 'expected a real GY gdp_growth series alongside the news, for the mixed-ref test');
const realNewsRef = newsPkg.evidenceMeta.find(m => m.ref.startsWith('N:')).ref;
const realDataRef = newsPkg.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;

test('a news-only claim carrying a figure is flagged — news evidence is headline metadata only', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'context',
      refs: [realNewsRef],
      figures: [{ ref: realNewsRef, year: 2026, value: 1, unit: '%', calculation: null, asWritten: '1%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, newsPkg);
  const violations = result.violations.filter(v => v.check === 'news_body_claim');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /headline metadata only/);
});

test('a news-only claim with a short quote (5 words or fewer) is not flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The headline read "oil profits under scrutiny" this week.',
      type: 'context',
      refs: [realNewsRef],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, newsPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'news_body_claim'), []);
});

test('a news-only claim with a long quote (more than 5 words) is flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The article states, "the government will not release the full report until next quarter at the earliest."',
      type: 'context',
      refs: [realNewsRef],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, newsPkg);
  const violations = result.violations.filter(v => v.check === 'news_body_claim');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /quotes \d+ words/);
});

test('a claim citing both a D: ref and an N: ref is not news-only, even with a figure', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'context',
      refs: [realDataRef, realNewsRef],
      figures: [{ ref: realDataRef, year: 2024, value: 43.82, unit: '%', calculation: null, asWritten: '43.82' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, newsPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'news_body_claim'), []);
});

test('a news-only framing claim with neither a figure nor a long quote is not flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Recent coverage has focused on the oil sector.',
      type: 'framing',
      refs: [realNewsRef],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, newsPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'news_body_claim'), []);
});

// ── Check 8: quote check ─────────────────────────────────────────────────────────────────────

// No real capture predates Phase 3's Tavily integration, so none carries pkg.web — every one of
// these is hand-built, same convention checks 7/9 already use for evidence classes real captures
// don't exercise. `webRef` mirrors the real `W:${sha256(url)}` shape closely enough to exercise
// the check (byWebRef only ever keys off `W:${w.id}`, never re-derives the hash itself).
const WEB_RETRIEVED_AT = '2026-08-17T00:00:00.000Z';
const webRefWithExtract = 'W:web-1';
const webRefNoExtract = 'W:web-2';
const webPkg = {
  data: [],
  news: [],
  misses: [],
  caveats: [],
  toolsUsed: [],
  newsCoverage: { earliest: '', latest: '', count: 0 },
  web: [
    {
      id: 'web-1',
      title: 'Guyana GDP growth accelerates',
      url: 'https://example.com/guyana-gdp-2024',
      domain: 'example.com',
      publishedDate: '2024-06-01',
      retrievedAt: WEB_RETRIEVED_AT,
      snippet: 'Guyana GDP growth accelerates in 2024.',
      extract: { text: "Guyana's economy grew by 43.8% in 2024, driven mainly by oil output, the report said.", chars: 89, summary: null },
      authorizedBy: 'step-1',
    },
    {
      id: 'web-2',
      title: 'A page with no extract',
      url: 'https://example.com/no-extract',
      domain: 'example.com',
      publishedDate: null,
      retrievedAt: WEB_RETRIEVED_AT,
      snippet: 'A snippet only, never extracted.',
      extract: null,
      authorizedBy: 'step-1',
    },
  ],
  evidenceMeta: [
    { ref: webRefWithExtract, vintage: null, retrievedAt: WEB_RETRIEVED_AT, sourceRevisionDate: null, contentHash: null },
    { ref: webRefNoExtract, vintage: null, retrievedAt: WEB_RETRIEVED_AT, sourceRevisionDate: null, contentHash: null },
  ],
};

test('a quote that is a real substring of the cited extract text passes clean', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The report said the economy "grew by 43.8% in 2024, driven mainly by oil output".',
      type: 'context',
      refs: [webRefWithExtract],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'quote_check'), []);
});

test('a fabricated quote (not present in the extract text) is flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The report said the economy "collapsed by 12% in 2024".',
      type: 'context',
      refs: [webRefWithExtract],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  const violations = result.violations.filter(v => v.check === 'quote_check');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /collapsed by 12% in 2024/);
});

test('a claim with no quoted spans is unaffected by quote_check, even when it cites a W: ref', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The report discusses oil-driven growth in 2024.',
      type: 'context',
      refs: [webRefWithExtract],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'quote_check'), []);
});

test('a quote on a W: ref whose extract is null is flagged — a search snippet alone is never sufficient', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The page says "a snippet only, never extracted".',
      type: 'context',
      refs: [webRefNoExtract],
      figures: [],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  const violations = result.violations.filter(v => v.check === 'quote_check');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
});

// ── Check 9: cross-currency comparison ──────────────────────────────────────────────────────

// This check essentially never fires on real data (verified: zero true positives across all 9
// usable captures — no real claim mixes two genuinely non-percent units), so its coverage here
// leans on synthetic claims injected into a REAL evidence package rather than real captured
// claims, same convention as check 7. "research_question" is the one real capture whose evidence
// carries two DIFFERENT non-percent units at once: D:GY:current_account in 'US$ mn' and
// D:GY:fx_rate_usd in 'GY$ per US$' — a level in one currency vs. an exchange rate in another,
// exactly the kind of pair this check exists to catch.
const currencyCapture = usable.find(c => c.category === 'research_question');
const currencyEvidence = currencyCapture.result.evidence;
const currentAccountRef = currencyEvidence.evidenceMeta.find(m => m.ref === 'D:GY:current_account').ref;
const fxRateRef = currencyEvidence.evidenceMeta.find(m => m.ref === 'D:GY:fx_rate_usd').ref;

test('two figures in different non-% units plus comparative language is flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The current account deficit exceeds the exchange rate figure.',
      type: 'context',
      refs: [currentAccountRef, fxRateRef],
      figures: [
        { ref: currentAccountRef, year: 2021, value: -2823.7, unit: 'US$ mn', calculation: null, asWritten: '-2823.7' },
        { ref: fxRateRef, year: 2021, value: 206.5, unit: 'GY$ per US$', calculation: null, asWritten: '206.5' },
      ],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, currencyEvidence);
  const violations = result.violations.filter(v => v.check === 'cross_currency_comparison');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /US\$ mn/);
  assert.match(violations[0].detail, /GY\$ per US\$/);
});

test('two figures in different non-% units with NO comparative language is not flagged — units alone are not a violation', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The current account and the exchange rate are both reported below.',
      type: 'context',
      refs: [currentAccountRef, fxRateRef],
      figures: [
        { ref: currentAccountRef, year: 2021, value: -2823.7, unit: 'US$ mn', calculation: null, asWritten: '-2823.7' },
        { ref: fxRateRef, year: 2021, value: 206.5, unit: 'GY$ per US$', calculation: null, asWritten: '206.5' },
      ],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, currencyEvidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'cross_currency_comparison'), []);
});

test('two figures that are both percent-type (e.g. "%" and "% of GDP") with comparative language is not flagged — percentages are always comparable', () => {
  const capture = usable.find(c => c.category === 'regional');
  const { evidence } = capture.result;
  const debtRef = evidence.evidenceMeta.find(m => m.ref.startsWith('D:')).ref;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: "This economy's ratio exceeds the regional average.",
      type: 'context',
      refs: [debtRef],
      figures: [
        { ref: debtRef, year: 2024, value: 90, unit: '%', calculation: null, asWritten: '90' },
        { ref: debtRef, year: 2023, value: 80, unit: '% of GDP', calculation: null, asWritten: '80' },
      ],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'cross_currency_comparison'), []);
});

test('a claim with only one non-% figure is never flagged, regardless of comparative language', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The current account deficit exceeds expectations.',
      type: 'context',
      refs: [currentAccountRef],
      figures: [{ ref: currentAccountRef, year: 2021, value: -2823.7, unit: 'US$ mn', calculation: null, asWritten: '-2823.7' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, currencyEvidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'cross_currency_comparison'), []);
});

// ── Check 10: coverage honesty ──────────────────────────────────────────────────────────────

test('a figure whose year falls before the series\' earliest retrieved point is flagged', () => {
  const capture = usable.find(c => c.category === 'time_series'); // D:JM:inflation covers 2020-2025
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      figures: [{ ref: 'D:JM:inflation', year: 2015, value: 5, unit: '%', calculation: null, asWritten: '5' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  const violations = result.violations.filter(v => v.check === 'coverage_honesty');
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /2020–2025/);
});

test('a figure whose year falls after the series\' latest retrieved point is flagged', () => {
  const capture = usable.find(c => c.category === 'time_series');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      figures: [{ ref: 'D:JM:inflation', year: 2030, value: 5, unit: '%', calculation: null, asWritten: '5' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.filter(v => v.check === 'coverage_honesty').length, 1);
});

test('a figure whose year is exactly the earliest or latest retrieved point is NOT flagged — bounds are inclusive', () => {
  const capture = usable.find(c => c.category === 'time_series');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      figures: [
        { ref: 'D:JM:inflation', year: 2020, value: 5.23, unit: '%', calculation: null, asWritten: '5.23' },
        { ref: 'D:JM:inflation', year: 2025, value: 4, unit: '%', calculation: null, asWritten: '4' },
      ],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'coverage_honesty'), []);
});

test('a period_average figure (year: null) is never flagged by coverage_honesty', () => {
  const capture = usable.find(c => c.category === 'time_series');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:JM:inflation'],
      figures: [{ ref: 'D:JM:inflation', year: null, value: 999, unit: '%', calculation: 'period_average', asWritten: '999' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.deepEqual(result.violations.filter(v => v.check === 'coverage_honesty'), []);
});

test('a figure whose ref does not resolve at all produces no coverage_honesty violation — left to check 1', () => {
  const capture = usable.find(c => c.category === 'time_series');
  const { evidence } = capture.result;
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'x',
      type: 'figure',
      refs: ['D:XX:not_real'],
      figures: [{ ref: 'D:XX:not_real', year: 1900, value: 1, unit: '%', calculation: null, asWritten: '1' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, evidence);
  assert.equal(result.violations.filter(v => v.check === 'coverage_honesty').length, 0);
  assert.equal(result.violations.filter(v => v.check === 'ref_existence').length, 1);
});

// ── Check 11: web figure reconciliation ─────────────────────────────────────────────────────

// Reuses the same hand-built webPkg fixture as check 8 above (no real capture carries pkg.web).

test('a figure whose value genuinely appears in the extract text passes', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The economy grew by 43.8% in 2024.',
      type: 'figure',
      refs: [webRefWithExtract],
      figures: [{ ref: webRefWithExtract, year: 2024, value: 43.8, unit: '%', calculation: null, asWritten: '43.8%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  assert.deepEqual(result.violations.filter(v => v.check === 'web_figure_reconciliation'), []);
});

test('a fabricated figure (value not present anywhere in the extract text) is flagged', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'The economy grew by 91.2% in 2024.',
      type: 'figure',
      refs: [webRefWithExtract],
      figures: [{ ref: webRefWithExtract, year: 2024, value: 91.2, unit: '%', calculation: null, asWritten: '91.2%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  const violations = result.violations.filter(v => v.check === 'web_figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /could not be located in the retrieved extract text/);
});

test('a figure citing a W: ref with extract: null is flagged — a search snippet alone is never sufficient', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Some figure was reported.',
      type: 'figure',
      refs: [webRefNoExtract],
      figures: [{ ref: webRefNoExtract, year: 2024, value: 5, unit: '%', calculation: null, asWritten: '5%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  const violations = result.violations.filter(v => v.check === 'web_figure_reconciliation');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].claimId, 'claim-0');
  assert.match(violations[0].detail, /no extract/);
});

test('a figure whose W: ref does not resolve at all produces no web_figure_reconciliation violation — left to check 1', () => {
  const answer = {
    headline: 'x',
    claims: [{
      id: 'claim-0',
      text: 'Some figure was reported.',
      type: 'figure',
      refs: ['W:not-a-real-ref'],
      figures: [{ ref: 'W:not-a-real-ref', year: 2024, value: 5, unit: '%', calculation: null, asWritten: '5%' }],
    }],
    gaps: [],
  };

  const result = runGroundingGate(answer, webPkg);
  assert.equal(result.violations.filter(v => v.check === 'web_figure_reconciliation').length, 0);
  assert.equal(result.violations.filter(v => v.check === 'ref_existence').length, 1);
});

// ── figureMatches — the number-matching helper (§2.6) ──────────────────────────────────────

test('figureMatches: exact match at the written precision', () => {
  assert.equal(figureMatches(43.82, 43.82, '43.82'), true);
});

test('figureMatches: a model rounding 16.326 to "16.3" matches at that precision', () => {
  assert.equal(figureMatches(16.3, 16.326, '16.3'), true);
});

test('figureMatches: a genuinely wrong figure at the same precision does not match', () => {
  assert.equal(figureMatches(16.9, 16.326, '16.9'), false);
});

test('figureMatches: "about"/"roughly" hedges are allowed within 0.1% relative tolerance', () => {
  assert.equal(figureMatches(62, 62.3, 'about 62%'), true);
});

test('figureMatches: hedge tolerance is not unlimited', () => {
  assert.equal(figureMatches(50, 62.3, 'roughly 50%'), false);
});
