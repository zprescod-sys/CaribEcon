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
  /* summary and insights are both additive, optional 'newsExtract'-role output — text itself is
   * never edited or replaced by either. `summary` (plain prose) predates the Synthesis Latency +
   * Evidence Compiler upgrade and is kept only as a fallback field, no longer populated by
   * newsExtract.ts's news-digest path (which now emits `insights` instead) — remove once nothing
   * reads it. Neither field is ever checked by grounding.ts; only `text` is (see newsExtract.ts's
   * header for why). */
  extract: { text: string; chars: number; summary: string | null; insights: ArticleInsights | null } | null;
  authorizedBy: string; // ResearchStep['id'] — which validated plan step fetched this
}

/* One figure the News Extract Agent (newsExtract.ts) claims the article states. `value` is kept
 * as-written (never reparsed/renormalized here) for the same reason StatedFigure.asWritten is —
 * precision lives in the string. `textPresenceVerified` is a weak, extraction-time co-occurrence
 * check (does this number appear anywhere in the real text), NOT a grounding verdict — read
 * newsExtract.ts's header before using this field for anything beyond an early fabrication filter.
 * The real, substantive check (does *this* figure, cited in *this* claim, actually match) still
 * happens exactly once, downstream, in grounding.ts's web_figure_reconciliation.
 *
 * `country` is the model's inferred read of which country THIS figure (not the article as a
 * whole) is about — genuinely model-inferred, not caller-known, since a single article can name
 * more than one country and the article's own overall subject is not reliably the right answer
 * for every figure in it (see newsExtract.ts's prompt for the explicit anti-shortcut instruction).
 * Always a real hub country code after newsExtract.ts's coercion resolves it through
 * askTools.ts's resolveCountry(), or null when the model couldn't determine one — never a raw,
 * unresolved model string, which would silently fail to ever match a hub DataEvidence country in
 * the Evidence Compiler's exact-key dedup/conflict detection. */
export interface ImportantFigure {
  metric: string;
  value: string;
  period: string;
  country: string | null;
  textPresenceVerified: boolean;
}

/* An economic mechanism the article explicitly discusses, not one the extraction model invented
 * to explain a figure — `evidence` names what in the article text supports it, so a human (or a
 * later automated check) can trace the claim back to something real. */
export interface EconomicDriver {
  driver: string;
  mechanism: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
}

/* The News Extract Agent's structured output (Synthesis Latency + Evidence Compiler upgrade,
 * Stage A) — replaces the old plain-prose `summary`. Deliberately excludes anything the caller
 * already knows deterministically at the ARTICLE level (articleId, source, publishedAt, url,
 * the article's own overall country) — see newsExtract.ts's header for why asking a model to
 * reproduce known metadata is pure downside. Per-figure country on ImportantFigure is a distinct,
 * later addition: which country a SPECIFIC figure is about is not reliably the article's own
 * overall country and genuinely needs inference — see ImportantFigure's own doc comment. */
export interface ArticleInsights {
  keyClaims: string[];
  importantFigures: ImportantFigure[];
  economicDrivers: EconomicDriver[];
  relevantContext: string[];
  topics: string[];
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
  /* The evidence the HEADLINE itself rests on. Exists because the headline is prose the user
   * actually reads, but — unlike a Claim — it carried no refs and no figures, so the grounding
   * gate had nothing to check it against and it shipped unfiltered even when the claim backing it
   * was dropped (observed live: a headline asserting the economy "nearly tripled" survived after
   * the only claim carrying that period-average figure failed check 4). Giving the headline refs
   * is what lets verify() hold it to the same standard as the claims beneath it. May be empty for
   * a purely qualitative headline that asserts nothing specific. */
  headlineRefs: EvidenceRef[];
  claims: Claim[];
  gaps: string[]; // what the final answer could not address — see anticipatedGaps note above
}

/* Bounded conversational memory (ARCHITECTURE.md §2.7, §2.4 C3). A request-shape concept, not a
 * pipeline-internal type like ResearchAnswer above it — it describes INPUT the client supplies,
 * sanitized once at the api/ask.ts trust boundary before research()/interpret() ever see it, the
 * same discipline `question` itself already gets there. Lives here rather than beside
 * ResearchRequest in research.ts purely to avoid a research.ts <-> interpret.ts import cycle
 * (research.ts imports interpret(), so interpret.ts cannot import a type back from research.ts).
 * Its existence does not violate §2.7 rule 3 ("no contract may depend on OpenClaw memory
 * types") — this is a small, self-contained shape this buildathon defines itself, with no
 * dependency on any external memory system; every OTHER contract (ResearchIntent, EvidencePackage,
 * ResearchAnswer, ResearchResult) still type-checks and works identically whether or not any
 * caller ever populates a ConversationTurn.
 *
 * `headline`, not the full claims[]: §2.7 rule 2 requires memory stay "compact turns... never
 * evidence bodies." A prior headline is already a dense one-line summary and is never itself
 * evidence (it is model prose, distinct from the D:/N:/W: evidence it was built from) — used here
 * only as a LEAD for interpret()'s OWN new resolution, per rule 1, never re-asserted as fact.
 * Included even when that turn's `publishedHeadline` was false: an ungrounded headline is still a
 * legitimate hint about what the conversation is ABOUT (topic continuity), and using it to steer
 * intent resolution never bypasses the NEW turn's own re-retrieval and grounding — it cannot let
 * anything skip verification, only help find it.
 *
 * `refs`: D:/N: only, by construction of where this type is populated — api/ask.ts strips any W:
 * before a ConversationTurn is ever constructed, since web evidence is turn-local and must never
 * be accepted back from the client (§2.4 C3: a client echoing back "here is what that page said"
 * could alter the text while keeping the schema valid, defeating the grounding gate). Not
 * re-validated for hub existence here: a stale or hallucinated ref just fails to help interpret(),
 * exactly like an unresolvable slug already does — never trusted as evidence, only used to nudge
 * a prompt. */
export interface ConversationTurn {
  question: string;
  headline: string;
  refs: EvidenceRef[];
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
  /* True iff every ResearchAnswer.headlineRefs entry is carried by a claim that survived into
   * publishedClaims — an empty headlineRefs is vacuously true (a purely qualitative headline
   * asserts nothing specific, so there is nothing to violate, the same convention "zero claims ->
   * PASS" already uses below). False means the headline itself must not be shown as verified: its
   * evidence was dropped, or it cited something no claim ever carried at all. verify.ts derives
   * this the same way it derives publishedClaims — the caller (taskpane.js) decides what to
   * render instead, this module only decides whether the headline is presentable. */
  publishedHeadline: boolean;
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
  /* Additive (Stage C) — the task-pane-facing short note + collapsible detail, built
   * deterministically from compiled evidence (evidenceCompiler.ts's buildEvidenceNote()), never
   * from the model. See EvidenceNote's own doc comment. */
  evidenceNote: EvidenceNote;
}

// ── Compiled evidence (Synthesis Latency + Evidence Compiler upgrade, Stage B) ──────────────

/* A heuristic, iterable ranking — NEVER written onto DataEvidence/NewsEvidence/WebEvidence
 * themselves (those stay exactly the evidence-of-record grounding.ts checks against). It exists
 * only on a compiled EvidenceItem, computed by evidenceCompiler.ts. 'primary'/'comparable' reuse
 * DataEvidence.sourceTier's own real vocabulary (data/SCHEMA.md) for hub-sourced items;
 * 'journalism' and 'unverified' are new, compiler-only distinctions for news/web-sourced items,
 * which carry no tier concept of their own today. */
export type CompilerQualityTier = 'primary' | 'comparable' | 'journalism' | 'unverified';

/* One hub data point or pre-computed change/average, compiled from EITHER a real DataEvidence
 * series OR a news/web-extracted figure that survived newsExtract.ts's textPresenceVerified
 * check. For a news/web-extracted figure, `indicator` and `country` are each independently
 * resolved-or-preserved by evidenceCompiler.ts's normalizeWebItem: when askTools.ts's
 * resolveIndicator()/resolveCountry() can canonicalize the source's own text, this item becomes
 * genuinely comparable to real hub DataEvidence (dedup, conflict detection, and relevance ranking
 * all treat it as if it were hub-derived); when they can't, the source's original label/absence
 * is preserved as-is rather than discarded — still fully usable for display, citation, and
 * synthesis, but `indicator`/`country` then can only ever exact-match ANOTHER unresolved item
 * carrying that exact same raw label (two sources agreeing or disagreeing on the same non-hub
 * figure is still real signal), never a canonical hub slug/country code, and it earns no
 * canonical-relevance credit in statisticRelevance(). Unresolved does not mean unusable — it
 * means non-comparable to canonical hub data. `refs` carries every source that agreed on this
 * exact fact after dedup — see EvidenceCompiler's own dedup rule. */
export interface StatisticItem {
  type: 'statistic';
  refs: EvidenceRef[];
  country: string | null;
  indicator: string;
  period: string;
  value: number;
  unit: string;
  valueType: string; // DataPoint['type']: actual | estimate | projection | derived
  transformation: CalculationName | null; // null = raw retrieved/reported value
  compilerQualityTier: CompilerQualityTier;
}

/* A qualitative claim from News Hub metadata or a web/news extraction — with a `mechanism` only
 * when it came from newsExtract.ts's structured `economicDrivers` (a driver item); a plain
 * headline, keyClaim, or Tavily snippet has `mechanism: null` and lands in `externalEvidence`
 * rather than `driverEvidence` (see CompiledEvidence below). */
export interface NewsContextItem {
  type: 'news_context';
  refs: EvidenceRef[];
  country: string | null;
  claim: string;
  mechanism: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  source: string;
  date: string | null;
  topics: string[];
  compilerQualityTier: CompilerQualityTier;
}

/* Knowledge Hub placeholder (deferred — see the plan). Typed now so the compiler and synthesizer
 * can consume one later; `refs: []` always, since a concept isn't retrieval-sourced. Nothing
 * populates this today. */
export interface ConceptItem {
  type: 'concept';
  refs: EvidenceRef[];
  concept: string;
  explanation: string;
  mechanism: string;
  topics: string[];
}

export type EvidenceItem = StatisticItem | NewsContextItem | ConceptItem;

/* A structured limitation, not free prose — generated by the compiler from real evidence
 * metadata (misses, low-tier-only coverage, etc.), never asked of the synthesis model. This is
 * what lets Stage C emit a short deterministic note and Stage E's task-pane UI show a plain
 * `.length` count without MiniMax ever generating either. */
export interface EvidenceLimitation {
  reason: string;
  relatedRefs: EvidenceRef[];
}

/* Two or more EvidenceItems that, after correct normalization (country + metric/indicator +
 * period + unit + frequency + valueType + transformation — NOT metric+period alone, which would
 * false-flag e.g. CPI vs. GDP-deflator inflation or an annual vs. a monthly figure as conflicting)
 * report materially different values for what is otherwise the same fact. */
export interface EvidenceContradiction {
  description: string;
  items: EvidenceItem[];
}

/* The compact, synthesis-facing view evidenceCompiler.ts produces from a full EvidencePackage.
 * grounding.ts never reads this — it checks claims against the original EvidencePackage
 * unchanged (see docs/plan's safety-critical design decision). Every category is truncated to
 * its config.ts budget constant (MAX_KEY_FACTS, MAX_DRIVER_ITEMS, MAX_CONCEPTS,
 * MAX_EXTERNAL_FINDINGS, MAX_CONTRADICTIONS), highest-ranked first — an enforced invariant, not a
 * prompt preference. */
export interface CompiledEvidence {
  question: string;
  analysisGoal: string;
  keyFacts: EvidenceItem[];
  driverEvidence: EvidenceItem[];
  economicConcepts: ConceptItem[];
  externalEvidence: EvidenceItem[];
  contradictions: EvidenceContradiction[];
  gaps: EvidenceLimitation[];
  /* Passed through from EvidencePackage.caveats UNCHANGED — hard constraints (e.g. "these are
   * local-currency levels; do not difference or rank them across economies"), not gaps and not
   * compiler-detected. Not in the original spec's CompiledEvidence example; added because
   * dropping these would materially increase how often check 9 (cross_currency_comparison) has
   * to reject a synthesized claim after the fact, instead of the prompt preventing it upfront. */
  caveats: string[];
  /* Each validated ResearchStep's own `why` (plan.ts), in plan order — the planner's stated reason
   * for seeking that piece of evidence, never the model's own commentary. Context only, exactly
   * like economicConcepts: it tells synthesize() what the plan considered central to the question
   * so ordering/emphasis isn't guessed from the evidence alone, but it carries no ref and is never
   * independently citable. Deterministic and gate-irrelevant — verify() still checks `answer`
   * against the original EvidencePackage, never against this or anything else in CompiledEvidence. */
  investigationNotes: string[];
}

/* The task-pane-facing evidence note (Stage C/E) — `summary` is the short inline line,
 * `limitations` the detailed, collapsible list (each entry traceable to real refs via
 * EvidenceLimitation.relatedRefs). Built by evidenceCompiler.ts's buildEvidenceNote(), from
 * compiled.gaps/contradictions — never asked of the synthesis model, so its count and content
 * can't drift from what the compiler actually knows. Empty (`summary: ''`) when there is nothing
 * to report. */
export interface EvidenceNote {
  summary: string;
  limitations: EvidenceLimitation[];
}
