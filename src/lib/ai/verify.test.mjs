/* Tests for verify() (src/lib/ai/verify.ts) — the derivation of a VerificationVerdict from the
 * real grounding gate (grounding.ts) plus an optional model claims audit.
 *
 * No mocks — same standing policy as the other src/lib/ai tests. Run against the real captures
 * in fixtures/askCaptures.json, using the same readFileSync/fileURLToPath/`usable` pattern as
 * grounding.test.mjs, so this exercises verify() against what the pipeline actually produces —
 * not just hand-built ResearchAnswer objects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verify } from './verify.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const captures = JSON.parse(readFileSync(join(__dirname, 'fixtures/askCaptures.json'), 'utf8'));

// Same filter as grounding.test.mjs — captures that failed before synthesis (result: null) have
// no ResearchAnswer to verify.
const usable = captures.filter(c => c.result !== null);
assert.ok(usable.length >= 5, 'expected several usable real captures to test against');

function capture(category) {
  const found = usable.find(c => c.category === category);
  assert.ok(found, `expected a usable capture for category "${category}"`);
  return found.result;
}

// ── Hand-built cases ─────────────────────────────────────────────────────────────────────────

test('zero violations -> PASS, every claim id published, no reason categories', () => {
  const { evidence } = capture('simple_factual');
  const answer = {
    headline: 'x',
    claims: [
      { id: 'claim-0', text: 'General context.', type: 'framing', refs: [], figures: [] },
      { id: 'claim-1', text: 'More context.', type: 'framing', refs: [], figures: [] },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'PASS');
  assert.deepEqual(verdict.publishedClaims, ['claim-0', 'claim-1']);
  assert.deepEqual(verdict.reasonCategories, []);
});

test('one violating claim among two -> NARROW, the violator excluded, the clean claim kept', () => {
  const { evidence } = capture('simple_factual');
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'x',
        type: 'figure',
        refs: ['D:XX:not_a_real_series'],
        figures: [],
      },
      { id: 'claim-1', text: 'General context.', type: 'framing', refs: [], figures: [] },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, ['claim-1']);
});

test('CHECK_REASON mapping: an unstated_number-style violation produces ungrounded_figure', () => {
  const { evidence } = capture('simple_factual'); // D:GY:gdp_growth, 2024 = 43.82
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'GDP growth reached an unprecedented 250.7% in 2024.',
        type: 'context',
        refs: ['D:GY:gdp_growth'],
        figures: [],
      },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.reasonCategories, ['ungrounded_figure']);
});

test('CHECK_REASON mapping: a cross_currency_comparison-style violation produces source_conflict', () => {
  const { evidence } = capture('research_question'); // has D:GY:current_account (US$ mn) and D:GY:fx_rate_usd (GY$ per US$)
  const currentAccountRef = evidence.evidenceMeta.find(m => m.ref === 'D:GY:current_account').ref;
  const fxRateRef = evidence.evidenceMeta.find(m => m.ref === 'D:GY:fx_rate_usd').ref;
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'The current account deficit exceeds the exchange rate figure.',
        type: 'context',
        refs: [currentAccountRef, fxRateRef],
        // Real retrieved values (not fabricated ones) — so this claim trips ONLY check 9
        // (cross_currency_comparison), not also check 4 (figure_reconciliation).
        figures: [
          { ref: currentAccountRef, year: 2021, value: -1995, unit: 'US$ mn', calculation: null, asWritten: '-1995' },
          { ref: fxRateRef, year: 2021, value: 208.5, unit: 'GY$ per US$', calculation: null, asWritten: '208.5' },
        ],
      },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.reasonCategories, ['source_conflict']);
});

test('multiple violations across multiple claims: all violators excluded, reasonCategories deduplicated', () => {
  const { evidence } = capture('simple_factual');
  const answer = {
    headline: 'x',
    claims: [
      { id: 'claim-0', text: 'x', type: 'figure', refs: ['D:XX:not_real_1'], figures: [] },
      { id: 'claim-1', text: 'x', type: 'figure', refs: ['D:XX:not_real_2'], figures: [] },
      { id: 'claim-2', text: 'General context.', type: 'framing', refs: [], figures: [] },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, ['claim-2']);
  // Two ref_existence violations (one per bad claim) both map to 'ungrounded_figure' — deduped
  // to a single entry, proof this is built from a Set and not one push per violation.
  assert.deepEqual(verdict.reasonCategories, ['ungrounded_figure']);
});

test('a hand-constructed ClaimsAudit finding also drops its claim and contributes its AUDIT_REASON category', () => {
  // Phase 4 never actually produces a `ran: true` ClaimsAudit yet (contracts.ts: every caller
  // today passes the default `{ ran: false }`) — same situation as check 7's tests in
  // grounding.test.mjs, "nothing real exercises this path yet." This audit is entirely synthetic,
  // exercising the derivation logic ahead of Phase 4 actually existing.
  const { evidence } = capture('simple_factual');
  const answer = {
    headline: 'x',
    claims: [
      { id: 'claim-0', text: 'General context.', type: 'framing', refs: [], figures: [] },
      { id: 'claim-1', text: 'More context.', type: 'framing', refs: [], figures: [] },
    ],
    gaps: [],
  };
  const audit = {
    ran: true,
    provider: 'test-provider',
    findings: [{ claimId: 'claim-0', finding: 'overreach', detail: 'reads more certain than the evidence supports' }],
  };

  const verdict = verify(answer, evidence, audit);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, ['claim-1']);
  assert.deepEqual(verdict.reasonCategories, ['low_confidence']);
  assert.deepEqual(verdict.audit, audit);
});

test('zero claims to begin with -> PASS, publishedClaims: [] — an empty answer is not "narrowed"', () => {
  const { evidence } = capture('simple_factual');
  const answer = { headline: 'x', claims: [], gaps: [] };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'PASS');
  assert.deepEqual(verdict.publishedClaims, []);
  assert.deepEqual(verdict.reasonCategories, []);
});

// ── Against all 9 usable real captures: exact precomputed results ─────────────────────────────

const CLEAN_CATEGORIES = [
  'simple_factual',
  'time_series',
  'ambiguous',
  'out_of_hub_country',
  'out_of_range_years',
  'vague_short',
];

for (const category of CLEAN_CATEGORIES) {
  test(`real capture "${category}": PASS, every claim id published, no reason categories`, () => {
    const { answer, evidence } = capture(category);
    const verdict = verify(answer, evidence);
    assert.equal(verdict.outcome, 'PASS');
    assert.deepEqual(verdict.publishedClaims, answer.claims.map(c => c.id));
    assert.deepEqual(verdict.reasonCategories, []);
  });
}

// "research_question" claim-5 states a true but undeclared "0.00%" generalizing across every
// year not individually named — grounding.test.mjs's KNOWN_EXPECTED_VIOLATIONS carries the full
// explanation of why this is a correct, expected flag rather than a false positive.
test('real capture "research_question": NARROW, claim-5 excluded (claims 0-4, 6 published)', () => {
  const { answer, evidence } = capture('research_question');
  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(
    verdict.publishedClaims,
    answer.claims.map(c => c.id).filter(id => id !== 'claim-5'),
  );
  assert.ok(verdict.reasonCategories.includes('ungrounded_figure'));
});

test('real capture "regional": NARROW, claim-6 excluded (claims 0-5 published)', () => {
  const { answer, evidence } = capture('regional');
  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, ['claim-0', 'claim-1', 'claim-2', 'claim-3', 'claim-4', 'claim-5']);
  assert.ok(verdict.reasonCategories.includes('ungrounded_figure'));
});

test('real capture "multi_country_comparison": NARROW, claim-5 excluded (a middle element, not the last)', () => {
  const { answer, evidence } = capture('multi_country_comparison');
  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, ['claim-0', 'claim-1', 'claim-2', 'claim-3', 'claim-4', 'claim-6']);
  assert.ok(verdict.reasonCategories.includes('ungrounded_figure'));
});

// ── Adversarial review regression: percent-shaped whole numbers must not slip through the
// unstated_number check's small-count exemption ─────────────────────────────────────────────
//
// Both cases below are the adversarial reviewer's own repro, verbatim: a hand-built claim citing
// the real D:GY:gdp_growth ref (2024 actual = 43.82, per the "simple_factual" capture) with an
// empty figures[] (no declared StatedFigure) and a fabricated percentage in prose. Before the
// fix, checkUnstatedNumber's "0-30 is a small narrative count" exemption in grounding.ts silently
// waved both through — a fabricated 27% (finding 1) and a fabricated 0.00% (finding 2, which also
// proved Number.isInteger(0.00) collapses the fractional-looking literal to a whole number) — so
// verify() published a claim with no real grounding at all. Guarded here, not only in
// grounding.test.mjs, because this is the exact failure the adversarial review's stated goal
// warned about: "a hallucinated figure would reach a user."
test('ADVERSARIAL REVIEW REGRESSION: a fabricated whole-number percentage in prose (no declared figure) is dropped, not published', () => {
  const { evidence } = capture('simple_factual'); // D:GY:gdp_growth, 2024 actual = 43.82
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'Guyana growth has been remarkably strong, at one point reaching a scorching 27% pace before moderating.',
        type: 'context',
        refs: ['D:GY:gdp_growth'],
        figures: [],
      },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, []);
  assert.deepEqual(verdict.reasonCategories, ['ungrounded_figure']);
});

test('ADVERSARIAL REVIEW REGRESSION: a fabricated "0.00%" (a whole number once parsed) is dropped, not published', () => {
  const { evidence } = capture('simple_factual'); // D:GY:gdp_growth, 2024 actual = 43.82
  const answer = {
    headline: 'x',
    claims: [
      {
        id: 'claim-0',
        text: 'Guyana growth reached a scorching 0.00% pace before moderating.',
        type: 'context',
        refs: ['D:GY:gdp_growth'],
        figures: [],
      },
    ],
    gaps: [],
  };

  const verdict = verify(answer, evidence);
  assert.equal(verdict.outcome, 'NARROW');
  assert.deepEqual(verdict.publishedClaims, []);
  assert.deepEqual(verdict.reasonCategories, ['ungrounded_figure']);
});

// ── The motivating case, as its own self-evident test ──────────────────────────────────────

test('THE BUG THIS TASK FIXES: the "regional" claim mentioning "Central Bank" (the fabricated debt figure) is not published', () => {
  const { answer, evidence } = capture('regional');
  const centralBankClaim = answer.claims.find(c => c.text.includes('Central Bank'));
  assert.ok(centralBankClaim, 'expected the "regional" capture to contain a claim mentioning "Central Bank"');

  const verdict = verify(answer, evidence);
  assert.ok(
    !verdict.publishedClaims.includes(centralBankClaim.id),
    `expected claim "${centralBankClaim.id}" (the fabricated Central Bank debt figure) to be excluded from publishedClaims`,
  );
});
