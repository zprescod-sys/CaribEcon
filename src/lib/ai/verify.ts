/* verify() — the Verification role (ARCHITECTURE.md §3.1: "verify(answer, pkg) -> Verification-
 * Verdict // gate (code) + audit (model)"). Pure derivation: it calls the real, always-on
 * grounding gate (grounding.ts, Phase 2) and combines its result with an optional model claims
 * audit (Phase 4, not built yet — every caller today passes the default `{ ran: false }`) into
 * the one VerificationVerdict the rest of the pipeline reads. This module holds the ONLY logic
 * that decides which claims get published — grounding.ts finds problems but never acts on them
 * (see its own header comment), and nothing else in the codebase re-derives publishedClaims or
 * outcome from a GroundingResult. Keeping that derivation in exactly one place is what §2.5 warns
 * about: "rebuilding these is the most common way to end up with two sources of truth."
 */
import { runGroundingGate } from './grounding.js';
import type {
  AuditFinding,
  ClaimsAudit,
  EvidencePackage,
  GroundingCheck,
  ReasonCategory,
  ResearchAnswer,
  VerificationVerdict,
} from './contracts.js';

/* Every GroundingCheck maps to a ReasonCategory. Declared as `Record<GroundingCheck, ReasonCategory>`
 * (exhaustive, not `Partial`) so TypeScript refuses to compile the day a twelfth check is added to
 * the union without a decision being made here too — that is the regression guard, not a comment.
 *
 * cross_currency_comparison is the one outlier, mapped to 'source_conflict' rather than
 * 'ungrounded_figure': every other check catches a figure or reference with NO evidentiary backing
 * at all (a fabricated number, a missing ref, an out-of-range year...) — there is simply nothing
 * real behind the claim. cross_currency_comparison is different in kind: both figures it flags are
 * genuinely retrieved and genuinely cited, the problem is that the claim's prose treats two
 * evidenced-but-incommensurate units (e.g. a US$ level vs. a GY$-per-US$ exchange rate) as if they
 * were directly comparable. That is a conflict between two real sources being asked to say
 * something neither supports on its own, not an absence of grounding — hence 'source_conflict'.
 *
 * quote_check and web_figure_reconciliation are included even though grounding.ts does not
 * implement them yet (its own header: both are deferred `W:` web-evidence rules with nothing to
 * check until Phase 3's Tavily integration exists). Both would catch the same kind of problem as
 * every other non-cross-currency check — an assertion with no real backing — so both land on
 * 'ungrounded_figure' too. Filling them in now means this table needs no revisiting the day Phase
 * 3 turns them on.
 */
const CHECK_REASON: Record<GroundingCheck, ReasonCategory> = {
  ref_existence: 'ungrounded_figure',
  url_allowlist: 'ungrounded_figure',
  slug_tokens: 'ungrounded_figure',
  figure_reconciliation: 'ungrounded_figure',
  wrong_calculation: 'ungrounded_figure',
  unstated_number: 'ungrounded_figure',
  news_body_claim: 'ungrounded_figure',
  quote_check: 'ungrounded_figure',
  cross_currency_comparison: 'source_conflict',
  coverage_honesty: 'ungrounded_figure',
  web_figure_reconciliation: 'ungrounded_figure',
};

/* Every AuditFinding maps to a ReasonCategory. Same exhaustive-Record discipline as above — a
 * fifth AuditFinding added to contracts.ts fails the build here until someone decides where it
 * lands, rather than silently falling through to no reasonCategory at all.
 *
 * - overreach -> 'low_confidence': the model verifier judged the claim as reading more certain
 *   than the evidence supports — a confidence problem, not a missing-source problem.
 * - weak_attribution -> 'ungrounded_figure': the claim leans on a source too thin to carry it —
 *   same family as every grounding-gate check that catches "asserted without real backing."
 * - unhedged_causal_language -> 'unattributed_causation': the one AuditFinding with its own
 *   dedicated ReasonCategory, because it is a distinct failure mode from either of the above — the
 *   claim asserts X caused Y without hedging, which §2.3(b) says code/audit can catch as language
 *   but never adjudicate as true. It deserves its own label so a caller can tell "this claim implied
 *   causation" apart from "this claim was just thin on sourcing."
 * - scope_drift -> 'low_confidence': the claim wandered outside what the question/evidence scope
 *   actually supports — like overreach, this is about the claim being more confident/broad than
 *   what was actually asked or retrieved, not about a missing citation.
 */
const AUDIT_REASON: Record<AuditFinding, ReasonCategory> = {
  overreach: 'low_confidence',
  weak_attribution: 'ungrounded_figure',
  unhedged_causal_language: 'unattributed_causation',
  scope_drift: 'low_confidence',
};

/* verify() itself. Signature and behaviour are ARCHITECTURE.md §3.1's Verification role, made
 * concrete:
 *   - grounding always runs (grounding.ts "cannot fail open"), so its violations are always part
 *     of droppedClaimIds.
 *   - audit only contributes when `audit.ran === true` — Phase 4 isn't built, so every call site
 *     today passes the default and this branch is currently dead in production, but the logic
 *     must be right now so wiring in the real audit later is purely additive, not a rewrite.
 *   - a dropped claim is EXCLUDED, never edited — "only code can produce a number" (§2.3c), so
 *     there is no such thing as a partially-published claim in this design.
 *   - outcome is binary: PASS iff nothing was dropped, NARROW otherwise (including the case where
 *     every claim is dropped) — RETRY/ESCALATE are reserved enum values with no machinery behind
 *     them yet (§2.3c).
 */
export function verify(
  answer: ResearchAnswer,
  pkg: EvidencePackage,
  audit: ClaimsAudit = { ran: false },
): VerificationVerdict {
  const grounding = runGroundingGate(answer, pkg);

  const droppedClaimIds = new Set<string>(grounding.violations.map(v => v.claimId));
  if (audit.ran) {
    for (const finding of audit.findings) droppedClaimIds.add(finding.claimId);
  }

  const publishedClaims = answer.claims.map(c => c.id).filter(id => !droppedClaimIds.has(id));

  // An answer with no claims at all has nothing to drop and nothing wrong with it — PASS, not
  // NARROW. Distinct from "some claims were dropped down to zero," which IS NARROW.
  const outcome = droppedClaimIds.size === 0 ? 'PASS' : 'NARROW';

  // Deduplicated, order-preserved by first occurrence (Set insertion order), so reasonCategories
  // is deterministic across runs of the same violations rather than depending on iteration quirks.
  const reasonCategories = new Set<ReasonCategory>();
  for (const violation of grounding.violations) reasonCategories.add(CHECK_REASON[violation.check]);
  if (audit.ran) {
    for (const finding of audit.findings) reasonCategories.add(AUDIT_REASON[finding.finding]);
  }

  return {
    outcome,
    grounding,
    audit,
    publishedClaims,
    reasonCategories: [...reasonCategories],
  };
}
