/* Typed contracts for the Ask CaribEcon Research Agent pipeline (ARCHITECTURE.md §2.5).
 *
 * Types only. No runtime code, no values, nothing that needs a JS file to exist at import time —
 * every export here is erasable at compile time. That is not a style preference: C1 in
 * ARCHITECTURE.md §2.4 means the Excel task pane can only import a src/lib/ai/* module if it
 * carries zero runtime imports (webpack's resolve.extensions has no extensionAlias, so it cannot
 * resolve an explicit ./foo.js specifier to a foo.ts on disk — the pane gets away with importing
 * excelOutputs.ts today only because every import there is `import type`). Keep it that way as
 * this file grows: a stray runtime import here silently breaks that door, not loudly.
 *
 * §2.5's own warning governs how this file is organised: "map before you build, because
 * rebuilding these is the most common way to end up with two sources of truth." So this file
 * reuses every contract that already exists — EvidencePackage, DataEvidence, RetrievalMiss,
 * NewsEvidence, CalculationResult, SingleCountryIntent/CountryComparisonIntent, ChartSpec,
 * WorkbookPlan — by importing them, never by redeclaring them. What follows is only what
 * genuinely does not exist yet: evidence identity across three source classes, the research
 * plan, the claim-structured answer, and the verification verdict.
 *
 * EvidencePackage itself is not edited here. §2.5 specifies it gains exactly two additive
 * fields (`web?: WebEvidence[]`, `evidenceMeta: EvidenceMeta[]`) directly on the interface in
 * askTools.ts — a separate, small step, not bundled into this one.
 */

// ── Reused, not redeclared ──────────────────────────────────────────────────────────────────

export type {
  EvidencePackage,
  DataEvidence,
  DataPoint,
  RetrievalMiss,
  AskIntent,
} from '../askTools.js';

export type { NewsEvidence } from '../news.js';
export type { CalculationResult, CalculationName } from '../calculations.js';
import type { CalculationName } from '../calculations.js';
export type {
  SingleCountryIntent,
  CountryComparisonIntent,
  ExcelIntent,
} from '../excelIntent.js';
export type { ChartSpec, WorkbookPlan } from '../excelOutputs.js';

import type { AskIntent } from '../askTools.js';

/* §3.1: "interpret(question, history) -> ResearchIntent... reuses canonicaliseIntent." The
 * Research Agent's interpret step produces exactly what canonicaliseIntent already validates
 * into — an alias, not a parallel shape, so there is only ever one "what did the model ask for"
 * type in the codebase. Bounded conversational context (§2.7 rule 2: MAX_HISTORY_TURNS turns of
 * compact history, never evidence bodies) is a planning-time input to interpret(), not a field
 * of its output, so it does not appear here. */
export type ResearchIntent = AskIntent;

// ── Evidence identity (§2.5, §2.4 C3) ───────────────────────────────────────────────────────

/* One ID namespace over three evidence classes, layered ON TOP OF excelOutputs.evidenceId()
 * rather than replacing it — that function's output ("GY:gdp_growth") is already written into
 * users' saved workbooks, so D: refs are literally `D:${evidenceId(...)}`.
 *
 * Identity vs. version: this ref identifies the SOURCE/SERIES, not a frozen value. "D:GY:
 * nominal_gdp" stays stable across a data revision so a workbook cell can always be traced back
 * to its series; EvidenceMeta below is what says which VERSION actually produced a given answer.
 * Conflating the two would make reproducibility impossible — you could trace a claim to "the
 * Guyana GDP series" without ever knowing which vintage of it produced the number in front of
 * you. */
export type EvidenceRef =
  | `D:${string}` // D:GY:nominal_gdp — the series identity; stable across revisions
  | `N:${string}` // N:<news id> — deployment-stable (CI regenerates news.json daily)
  | `W:${string}`; // W:<sha256(url)> — THIS REQUEST ONLY. Never accepted back from a client (§2.4 C3).

/* The version actually used, alongside the stable ref. Reuses DataEvidence.vintage — no new
 * provenance concept, just made addressable per-ref rather than only per-series. */
export interface EvidenceMeta {
  ref: EvidenceRef;
  vintage: string | null; // DataEvidence.vintage — dataset vintage, when the hub has one
  retrievedAt: string; // ISO instant this ref was resolved for THIS result
  sourceRevisionDate: string | null; // publisher's own revision date, when known (mostly W:)
  contentHash: string | null; // optional; strongest reproducibility signal when present
}

/* Web evidence is a distinct class from News precisely because it is quotable — News is
 * headline-metadata-only (askTools.ts's comparability caveat), Web carries an extract. `extract`
 * is present only when Tavily Extract ran on this step; a search snippet alone is never
 * sufficient grounding for a quantitative claim (§2.6 check 11). */
export interface WebEvidence {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedDate: string | null; // only when Tavily supplies one
  retrievedAt: string; // ISO instant — this is the web; it moves under you
  snippet: string;
  extract: { text: string; chars: number } | null;
  authorizedBy: string; // ResearchStep['id'] — which validated plan step fetched this
}

// ── Research plan (§2.3, §3.2) ──────────────────────────────────────────────────────────────

/* Every step names the deterministic tool it authorizes and carries its own why, so
 * validateResearchPlan (Phase 3) can check each one against resolveCountry/resolveIndicator the
 * same way canonicaliseIntent already does, and so a Tavily call is authorized by A STEP rather
 * than by a runtime decision — see WebEvidence.authorizedBy above. */
export type ResearchStep =
  | {
      id: string;
      tool: 'get_series';
      country: string;
      indicator: string;
      yearFrom: number | null;
      yearTo: number | null;
      why: string;
    }
  | {
      id: string;
      tool: 'compare_series';
      countries: string[];
      indicator: string;
      yearFrom: number | null;
      yearTo: number | null;
      why: string;
    }
  | {
      id: string;
      tool: 'search_news';
      countries: string[];
      keywords: string[];
      dateFrom: string | null;
      dateTo: string | null;
      why: string;
    }
  | { id: string; tool: 'search_web'; query: string; dateFrom: string | null; dateTo: string | null; why: string }
  | { id: string; tool: 'extract_web'; onStep: string; maxUrls: number; why: string };

export interface ResearchPlan {
  question: string; // echoed verbatim; the auditor compares scope against it
  scope: { countries: string[]; indicators: string[]; yearFrom: number | null; yearTo: number | null };
  steps: ResearchStep[]; // truncated to MAX_PLAN_STEPS (config.ts), not rejected
  /* Named anticipatedGaps, not "unanswerable": the planner is guessing BEFORE retrieval runs, so
   * it can name what looks out of reach, never certify what actually is. Distinct from
   * EvidencePackage.misses (actual retrieval misses, by code) and ResearchAnswer.gaps (what the
   * final answer could not address, after synthesis) — three different "what's missing" signals,
   * deliberately not merged (§2.5). */
  anticipatedGaps: string[];
}

// ── Claim-structured answer (§2.5, §7 item 4) ───────────────────────────────────────────────

/* The highest-leverage field in the whole design: turns "parse figures out of prose" (lossy,
 * never finishes) into "cross-check prose against declared figures" (exact). A synthesizer
 * emits its figures as data, not as something the grounding gate has to extract from text. */
export interface StatedFigure {
  ref: EvidenceRef;
  year: number | null;
  value: number; // unit-normalised
  unit: string;
  calculation: CalculationName | null; // null = raw retrieved value
  asWritten: string; // "16.3%" — the literal substring in Claim.text
}

export interface Claim {
  id: string; // stable per answer, independent of array position
  text: string;
  refs: EvidenceRef[]; // [] allowed ONLY when type === 'framing'
  type: 'figure' | 'trend' | 'context' | 'framing';
  figures: StatedFigure[];
}

export interface ResearchAnswer {
  headline: string;
  claims: Claim[];
  gaps: string[]; // what the final answer could not address — see anticipatedGaps note above
}

// ── Verification (§2.3(b), §2.6) ────────────────────────────────────────────────────────────

/* One entry per grounding-gate check that a specific claim failed. `check` names which of the
 * checks in §2.6 fired, so a violation is debuggable without re-deriving it from `detail`. */
export type GroundingCheck =
  | 'ref_existence'
  | 'url_allowlist'
  | 'slug_tokens'
  | 'figure_reconciliation'
  | 'wrong_calculation'
  | 'unstated_number'
  | 'news_body_claim'
  | 'quote_check'
  | 'cross_currency_comparison'
  | 'coverage_honesty'
  | 'web_figure_reconciliation';

export interface GroundingViolation {
  claimId: string;
  check: GroundingCheck;
  detail: string;
}

/* `ran` is the literal type `true`, not `boolean` — the gate "always runs, cannot fail open"
 * (§2.6), so there is no code path that produces a GroundingResult with ran: false. Contrast
 * with ClaimsAudit below, which genuinely can be absent. */
export interface GroundingResult {
  ran: true;
  violations: GroundingViolation[];
}

/* What a model verifier can check about qualitative claims — attribution and overreach, never
 * truth (§2.3(b): "A verifier cannot check truth... only attribution and overreach"). */
export type AuditFinding = 'overreach' | 'weak_attribution' | 'unhedged_causal_language' | 'scope_drift';

export interface ClaimsAuditFinding {
  claimId: string;
  finding: AuditFinding;
  detail: string;
}

/* A union, not an optional-fields object, so "the audit did not run" is a distinct, checkable
 * variant rather than a findings array that happens to be empty — those mean different things
 * (no independent check was possible vs. an independent check found nothing). Phase 4 (§7)
 * builds the `ran: true` side; until then, and whenever §4.2b's same-provider check requires
 * skipping it, every ClaimsAudit is `{ ran: false }`. */
export type ClaimsAudit = { ran: false } | { ran: true; provider: string; findings: ClaimsAuditFinding[] };

export type ReasonCategory = 'ungrounded_figure' | 'source_conflict' | 'low_confidence' | 'unattributed_causation';

/* outcome is DERIVED BY CODE from (grounding, audit) — never emitted by a model (§2.3(b): "A
 * model emitting its own verdict is a model grading a model with nothing checking the
 * grader"). publishedClaims narrows or rescopes; it never edits a number, because only code may
 * produce a number in the first place. */
export interface VerificationVerdict {
  outcome: 'PASS' | 'NARROW' | 'RETRY' | 'ESCALATE';
  grounding: GroundingResult;
  audit: ClaimsAudit;
  publishedClaims: string[]; // Claim.id[]
  reasonCategories: ReasonCategory[];
}

// ── The one Research Service response shape (§2.5) ─────────────────────────────────────────

import type { EvidencePackage } from '../askTools.js';

/* THE canonical Research Service response — research(request) -> ResearchResult, per §3.1's
 * public entry point. The service returns exactly this and nothing Excel-shaped: no
 * WorkbookPlan, no ChartSpec. A ReportBundle combining this with a client-built WorkbookPlan is
 * a CLIENT-layer structure (the Excel pane's own concern, §2.4 C2) — never what this service
 * returns. Earlier drafts used ResearchResult, ReportBundle and "endpoint response" loosely
 * interchangeably; this is the fix, and the reason it matters is a service with two names for
 * its own output invites two implementations of it. */
export interface ResearchResult {
  answer: ResearchAnswer;
  evidence: EvidencePackage;
  verdict: VerificationVerdict;
}
