/* synthesize() — ARCHITECTURE.md §3.1: "synthesize(intent, pkg) -> ResearchAnswer." Turns
 * compiled evidence into a claim-structured answer: a headline, a list of Claims, and a list
 * of gaps the evidence could not cover.
 *
 * PHASE 1 SCOPE, STATED EXPLICITLY: this validates that the model's output matches the
 * ResearchAnswer/Claim/StatedFigure SHAPE — right types, valid enum values, well-formed
 * strings. It does NOT check whether a cited ref actually exists in the package, whether a
 * figure's value actually matches what was retrieved, or anything else about whether a claim is
 * TRUE. That is entirely the grounding gate's job (§2.6, Phase 2) — "ref existence" and "figure
 * reconciliation" are checks 1 and 4 there, not duplicated here. Building even a cheap version
 * of that logic into this file would create two implementations of grounding that could drift
 * out of sync with each other, which is the exact failure mode §2.5 warns about for types,
 * applied here to behaviour instead. This still holds after the Synthesis Latency + Evidence
 * Compiler upgrade (Stage C): grounding.ts checks a claim against the ORIGINAL, untouched
 * EvidencePackage — never against the CompiledEvidence this file now reads — so a claim citing
 * a ref that only exists because of a compiler bug still fails check 1 exactly as before.
 *
 * ── Stage C: this file now reads CompiledEvidence, not a raw EvidencePackage ──
 * evidenceCompiler.ts (Stage B) produces a compact, pre-organised view — grouped by analytical
 * purpose, deduplicated, ranked, budget-capped — specifically so this prompt is smaller and this
 * role behaves like an analyst reasoning over curated evidence, not a summarizer enumerating a
 * raw dump. `describeIntent`/`describeSeries`/`describeWeb` (the old per-EvidencePackage prompt
 * builders) are gone; `evidenceCompiler.ts`'s `buildAnalysisGoal` and item normalization replace
 * them upstream, and `compiled.question`/`compiled.analysisGoal` carry what `describeIntent` used
 * to build here.
 *
 * ── The visible-answer ceiling is enforced in code, not left to "be concise" in the prompt ──
 * coerceAnswer below caps `claims[]` at MAX_VISIBLE_CLAIMS and then at a rough
 * MAX_VISIBLE_ANSWER_TOKENS estimate (config.ts) — dropping trailing (lowest-priority) claims
 * whole, never editing a kept claim's own text, so nothing a StatedFigure/quoted span was
 * anchored to ever shifts. The claims a user actually sees are the intersection of "the model
 * emitted it, within the cap" and "grounding didn't drop it" (verify.ts, unchanged).
 *
 * The one deliberate de-risking move beyond bare structural validation, unchanged since Phase 1:
 * derived figures (year-over-year change, period average) are PRE-COMPUTED — now by
 * evidenceCompiler.ts rather than this file — and handed to the model as evidence rather than
 * left for the model to calculate itself.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import { MAX_VISIBLE_CLAIMS, MAX_VISIBLE_ANSWER_TOKENS } from '../config.js';
import type {
  CompiledEvidence,
  EvidenceItem,
  ResearchAnswer,
  Claim,
  StatedFigure,
  EvidenceRef,
  CalculationName,
} from '../contracts.js';

export class SynthesizeNotConfiguredError extends Error {}

/* Distinct from a per-claim structural drop (see coerceAnswer below) the same way
   InterpretParseError is distinct from a RetrievalMiss: this means the model's response could
   not be read as a ResearchAnswer AT ALL — no headline, or claims/gaps are not even arrays. A
   single malformed claim inside an otherwise-valid response is not this; it is dropped and the
   rest of the answer is kept. */
export class SynthesizeParseError extends Error {
  constructor(
    public readonly rawText: string,
    // Diagnostic pair carried by all three role parse errors — see api/ask.ts's
    // structuredOutputFailure() for what they distinguish and why it matters.
    public readonly finishReason: string | null = null,
    public readonly completionTokens: number | null = null,
  ) {
    super('The model did not return a parseable ResearchAnswer.');
  }
}

// ── Evidence context, rendered from CompiledEvidence's own grouped, pre-ranked items ─────────

/* One line per compiled item, every ref it may be cited under shown explicitly — a dedup-merged
   item can carry more than one real ref (evidenceCompiler.ts retains all of them), and the model
   may cite ANY one of the listed refs; grounding.ts's ref_existence check only needs the cited
   ref to be real, not to be a specific one of several agreeing sources. */
function describeItem(item: EvidenceItem): string {
  const refs = item.refs.length ? item.refs.join(' | ') : '(no ref — not citable to a specific source)';
  if (item.type === 'statistic') {
    const calc = item.transformation ? ` [${item.transformation}]` : '';
    const country = item.country ?? 'unspecified country';
    return `${refs} — ${country} ${item.indicator}${calc}: ${item.value} ${item.unit} (${item.period}, ${item.valueType})`;
  }
  if (item.type === 'news_context') {
    const mechanism = item.mechanism ? ` | mechanism: ${item.mechanism}` : '';
    const confidence = item.confidence ? ` | confidence: ${item.confidence}` : '';
    const date = item.date ? `, ${item.date}` : '';
    return `${refs} — ${item.claim}${mechanism}${confidence} (${item.source}${date})`;
  }
  // concept — always refs: [], not citable; shown for context only (Knowledge Hub is a
  // schema placeholder today, so this branch is currently unreachable in practice).
  return `${refs} — ${item.concept}: ${item.explanation} | mechanism: ${item.mechanism}`;
}

/* Fourth iteration of this prompt. The first (git history: the plain-English rewrite) traded away
 * economic depth and evidentiary grounding for readability. The second restored depth but read as
 * a fact list glued together by transitions — every retrieved item earned a claim rather than
 * only the ones that advanced an argument. The third was modeled on a live side-by-side read
 * against a different model on identical evidence and added structural-vs-cyclical framing and
 * counterintuitive-finding flagging as named instructions — which worked, then over-corrected:
 * a live comparison run showed the model applying "structural, not cyclical" to a single GDP data
 * point and reaching for "Counterintuitively" on an ordinary fact, on almost every answer,
 * regardless of whether either actually clarified anything. This version keeps both as TOOLS —
 * used only when they genuinely serve the specific evidence in front of the model, explicitly
 * skipped for plain factual lookups and narrow comparisons — plus an explicit warning against
 * formulaic, templated analyst language once a phrase starts feeling reached-for rather than
 * observed. The rest is unchanged: lead with the relationship between facts, not the facts
 * themselves, and close with what the finding means, not one more data point. */
const ANALYST_INSTRUCTIONS = [
  'You are an economic analyst, not a general explainer. Write for an intelligent reader who is',
  'not an economist — simple language — but do not lose the analytical edge: real economic',
  'reasoning, named mechanisms when useful, and evidence, not a plain-English summary of the headline result.',
  '',
  'Preferred flow — adapt the order to whatever makes THIS question clearest; do not force a',
  'question into this shape if another order explains it better:',
  '',
  '1. LEAD WITH THE RELATIONSHIP, NOT THE NUMBERS: open with what the evidence MEANS — a',
  '   comparison, a trend, a gap, a tension — never a bare restatement of a figure. "Trinidad\'s',
  '   debt is nearly three times Guyana\'s, and the gap is structural" leads with the relationship;',
  '   "Guyana\'s debt is 28.6%, Trinidad\'s is 84.9%" does not — it is two numbers waiting for an',
  '   analyst to say what they mean. The numbers back up the relationship; they do not replace it.',
  '',
  '2. MECHANISM: name the actual channel at work (growth, investment, fiscal revenue, exports,',
  '   foreign exchange, inflation, employment, productivity, demand, external balances) whenever',
  '   one genuinely applies — translate the jargon, do not delete the economics.',
  '',
  '   STRUCTURAL VS. CYCLICAL is a TOOL for when it clarifies the mechanism — not a label to',
  '   attach to every answer. Reach for it when the distinction actually changes what the reader',
  '   should expect next (why a gap will or will not close, why a trend is durable vs. a swing',
  '   that could reverse). When you do use it, name both sides as a pair — "the gap is structural,',
  '   not cyclical" — never one label alone. For a simple factual lookup, a single data point, or',
  '   a narrow two-figure comparison, SKIP this framing and give a direct answer instead: stating',
  '   that ordinary growth "is structural, not cyclical" adds no information and reads as a label',
  '   applied out of habit, not analysis. Most claims should not use this pairing at all.',
  '',
  '3. EVIDENCE, AND — ONLY WHEN THE EVIDENCE GENUINELY HAS ONE — A COUNTERINTUITIVE FINDING:',
  '   ground each claim in the strongest available figures, dates, and sourced developments,',
  '   folded into the narrative ("GDP fell 3.2% in Q3 2025, driven primarily by...") rather than',
  '   listed separately.',
  '',
  '   A finding that genuinely cuts against what the headline number alone would suggest — and',
  '   that actually matters for the reader\'s conclusion, not merely sounds surprising — is worth',
  '   including. AT MOST ONE per answer, and only when it is clearly evidenced and decision-',
  '   relevant. Most answers legitimately have none; that is the normal case, not a gap to fill.',
  '   Do not go hunting for one to insert — if nothing in the evidence actually qualifies, skip',
  '   this entirely. A "Counterintuitively..." opener bolted onto an ordinary fact is worse than',
  '   not having one at all, and reads as a template, not a finding.',
  '',
  '4. THE IMPLICATION, NOT ANOTHER FACT: close by saying what the finding MEANS — what to watch,',
  '   what it implies, what would change the picture — never by adding one more data point. If',
  '   there is nothing more to say than another fact, stop the answer one claim earlier instead of',
  '   reaching for a close.',
  '',
  '── EVIDENCE VS. INFERENCE ──',
  '- State a mechanism as settled only when the evidence directly establishes it.',
  '- When a mechanism is your own plausible reading of the data rather than something the evidence',
  '  states outright, say so inline — "this points to...", "consistent with...", "likely',
  '  reflects..." — and still cite whatever evidence supports the inference, even if that evidence',
  '  does not state the mechanism directly. Never invent a mechanism just because it is',
  '  theoretically plausible with no evidentiary anchor at all.',
  '- If the evidence shows correlation or only partial support, say that plainly. Do not overstate',
  '  causality.',
  '',
  '── DISCIPLINE ──',
  '- 3-5 claims — a hard target, not a starting point to trim from. Choose the 3-5 that make the',
  '  single strongest argument and build one coherent narrative around them.',
  '- EXCEPTION, narrow: a question that asks to RANK, COMPARE, or SURVEY more than two entities',
  '  (e.g. "which economies have the highest debt burdens," "compare X, Y, and Z") may use up to',
  '  one claim per entity plus one closing synthesis claim — for THIS shape of question, leaving an',
  '  entity out of the answer is a worse failure than one extra claim. This exception is ONLY for',
  '  genuine multi-entity ranking/survey questions — never a general license to exceed 3-5 for a',
  '  single-country or two-way comparison question, which stay at the hard 3-5 target above.',
  '- Every claim must ADVANCE the argument — add something the reader does not already know from',
  '  the claims before it. If two claims restate the same point from different angles, cut one. A',
  '  fact earns its place by changing the reader\'s understanding of the main story, not by having',
  '  been retrieved — do not include one just because it is accurate and available.',
  '- Keep company announcements, policy changes, and individual news developments subordinate:',
  '  include them only when they help explain the main economic story, never because they were',
  '  retrieved.',
  '- Keep the answer concise — a focused argument that is easily interpretable, not an analyst',
  '  memo, a long report, or a checklist of every number the evidence happened to contain.',
  '- Never write a separate "evidence limitations" or "caveats" paragraph inside the narrative.',
  '  Anything the evidence could not establish belongs in gaps[], not in claim text.',
  '- Each claim\'s "text" must read as a complete, self-contained statement. It is rendered as its',
  '  own paragraph in one surface and space-joined with every other claim, back to back, in',
  '  another — so never open a claim with a dangling connective ("This is because...",',
  '  "Additionally,...") that only makes sense immediately after the previous one.',
  '- Avoid formulaic analyst language and repetition. If a phrase — "structural, not cyclical,"',
  '  "Counterintuitively," or any other analyst-sounding construction — is starting to feel like a',
  '  template reached for automatically rather than a genuine observation about THIS evidence, that',
  '  is the sign to stop reaching for it. Vary the language claim to claim, and prefer stating a',
  '  finding plainly over dressing an ordinary fact in analyst vocabulary that adds no insight.',
].join('\n');

function buildSystemPrompt(compiled: CompiledEvidence): string {
  const sections: string[] = [
    ANALYST_INSTRUCTIONS,
    '',
    `Question: ${compiled.question}`,
    `Analysis goal: ${compiled.analysisGoal}`,
  ];

  if (compiled.investigationNotes.length) {
    sections.push(
      '',
      "INVESTIGATION RATIONALE (why this evidence was sought, in retrieval order — not narrative",
      "importance). Use it to judge what the question is actually asking about, not as a template",
      'for claim order:',
      ...compiled.investigationNotes.map(n => `- ${n}`),
    );
  }

  sections.push(
    '',
    "KEY FACTS (each item's ref(s) shown — cite one exactly, never invent one):",
    ...(compiled.keyFacts.length ? compiled.keyFacts.map(describeItem) : ['(none retrieved)']),
  );

  if (compiled.caveats.length) {
    sections.push('', 'CAVEATS — hard constraints, not suggestions:', ...compiled.caveats.map(c => `- ${c}`));
  }
  if (compiled.driverEvidence.length) {
    sections.push('', 'POSSIBLE ECONOMIC DRIVERS:', ...compiled.driverEvidence.map(describeItem));
  }
  if (compiled.economicConcepts.length) {
    sections.push('', 'ECONOMIC CONCEPTS (context only, not independently citable):', ...compiled.economicConcepts.map(describeItem));
  }
  if (compiled.externalEvidence.length) {
    sections.push('', 'EXTERNAL CONTEXT:', ...compiled.externalEvidence.map(describeItem));
  }
  if (compiled.contradictions.length) {
    sections.push(
      '',
      'CONTRADICTORY EVIDENCE — sources disagree; hedge or note the disagreement, never silently pick one:',
      ...compiled.contradictions.map(c => `- ${c.description}`),
    );
  }
  if (compiled.gaps.length) {
    sections.push(
      '',
      'KNOWN GAPS — retrieval could not cover these; report honestly, do not guess:',
      ...compiled.gaps.map(g => `- ${g.reason}`),
    );
  }

  sections.push(
    '',
    'Respond with ONLY a JSON object in exactly this shape — no prose, no markdown fences:',
    JSON.stringify(
      {
        headline: 'string',
        headlineRefs: ['e.g. "D:GY:gdp_growth" — every ref the HEADLINE itself relies on, even a',
          'ref also cited by a claim below. Empty ONLY if the headline is pure framing with no',
          'specific figure or development named in it.'],
        claims: [
          {
            text: 'string',
            type: '"figure"|"trend"|"context"|"framing"',
            refs: ['e.g. "D:GY:gdp_growth" or "N:<id>" — refs this claim relies on'],
            figures: [
              {
                ref: 'string',
                year: 'number|null',
                value: 'number',
                unit: 'string',
                calculation: '"yoy_change"|"pp_change"|"period_average"|null',
                asWritten: 'string — the literal substring in text, e.g. "16.3%"',
              },
            ],
          },
        ],
        gaps: ['string'],
      },
      null,
      2,
    ),
    '',
    'Rules:',
    '- Every number in a claim\'s "text" — a percentage, a dollar amount, a count, anything —',
    '  must have a matching entry in that claim\'s "figures[]", including a number mentioned only',
    '  in passing, not just the claim\'s main statistic (e.g. "...its 50% profit share...", "...a',
    '  $55 billion investment...", "...67,000 passengers..." each need their own figures[] entry',
    '  exactly as much as the claim\'s headline number does). Before finalizing each claim, re-read',
    '  its "text" and check every number against "figures[]" — ONE undeclared number drops the',
    '  WHOLE claim, not just that number.',
    '- "calculation" must be null (a raw/reported value) or exactly one of the pre-computed values',
    '  shown above for that ref — never compute your own change, average, or any other derived',
    '  ratio (e.g. turning a dollar figure into "X% of GDP" yourself). State the number in the form',
    '  you were actually given, not a form you derived.',
    '- Only cite a ref shown above. Never invent one.',
    '- "ref" must be copied EXACTLY as shown above, up to (not including) the first " — ". A stat',
    '  line may show a trailing "[pp_change]"/"[yoy_change]"/"[period_average]" label — that names',
    '  which fact the line is, it is never part of the ref. Put that same value in "calculation"',
    '  instead; never append it to "ref".',
    '- A concept item (marked "no ref") may back only a "context" or "framing" claim, never a',
    '  figure — the same restriction a W: item with no extract is already held to.',
    '- "refs" may be empty ONLY when type is "framing" (general commentary, no specific evidence',
    '  tie). Every other claim needs at least one ref.',
    '- Respect every caveat above exactly as written — it is a constraint, not a suggestion.',
    '- Order your claims by importance — the most important conclusion first. If your answer runs',
    '  long, only the leading claims are guaranteed to be shown.',
    '- Never assert an inferred mechanism as settled fact. Hedge it inline in "text" ("this points',
    '  to...", "likely reflects...") and still cite whatever evidence supports the inference, even',
    '  if that evidence does not state the mechanism directly.',
    '- A closing "what this means" / "what to watch" claim is usually type "framing" (no required',
    '  refs) unless it cites a specific evidence-backed figure — and belongs LAST, since it is the',
    '  first claim dropped if the answer runs long.',
    '- "headlineRefs" must name every ref the headline itself depends on, even one already cited',
    '  by a claim below — the headline is checked against evidence exactly like a claim is, so an',
    '  unlisted ref means the headline can be suppressed even if every claim is fine.',
  );

  return sections.join('\n');
}

/* The exact two-message request is exported for the diagnostic replay harness. Keeping message
 * construction here prevents the harness from duplicating a long, safety-sensitive prompt and
 * accidentally testing something other than production synthesis. */
export function buildSynthesisMessages(compiled: CompiledEvidence): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(compiled) },
    { role: 'user', content: 'Write the research answer now, following the rules and shape exactly.' },
  ];
}

// ── Structural validation only — see the file header for why grounding checks are NOT here ──

const VALID_CLAIM_TYPES: readonly Claim['type'][] = ['figure', 'trend', 'context', 'framing'];
const VALID_CALCULATIONS: readonly CalculationName[] = ['yoy_change', 'pp_change', 'period_average'];

/* Defensive normalization, not the primary fix (that's the explicit "ref must be copied exactly"
 * prompt rule above) — a model can still fold part or all of describeItem()'s own rendering of a
 * stat line into the ref it emits, in two observed shapes:
 *   1. Just the trailing "[pp_change]"/"[yoy_change]"/"[period_average]" label, e.g.
 *      "D:GY:gross_govt_debt_pct_gdp [pp_change]" — a calculated stat's three facts (raw value,
 *      change, average) all share one base ref in the prompt, and that label is the only thing
 *      distinguishing them there.
 *   2. The ENTIRE line — ref, its own " — " separator, and the human-readable description after
 *      it, e.g. "D:JM:inflation — JM inflation: 5.23 % (2020, actual)" — observed live on a
 *      plain (non-calculated) stat, so this is not limited to case 1's calculated-stat ambiguity.
 * Stripping either here never changes which fact a ref points to — `calculation` and the claim's
 * own text already carry that, redundantly — it only removes a duplicate the model should not
 * have copied into `ref`. A real D:/N:/W: ref never legitimately contains " — " (describeItem()'s
 * own separator, an em dash) or ends in "[...]", so this can only ever turn an invented-looking
 * ref into a real, matchable one, never the reverse. Order matters: stripping the description
 * suffix first means case 2's own trailing bracket (inside the description) is already gone
 * before the bracket-only pattern runs, so it never has to handle both at once. */
const REF_DESCRIPTION_SUFFIX = / — .*$/;
const REF_CALC_SUFFIX = /\s*\[(?:yoy_change|pp_change|period_average)\]$/;
function normalizeRef(ref: string): EvidenceRef {
  return ref.replace(REF_DESCRIPTION_SUFFIX, '').replace(REF_CALC_SUFFIX, '').trim() as EvidenceRef;
}

function coerceFigure(raw: unknown): StatedFigure | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ref !== 'string' || !r.ref) return null;
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) return null;
  if (typeof r.unit !== 'string') return null;
  if (typeof r.asWritten !== 'string' || !r.asWritten) return null;
  const calculation = r.calculation ?? null;
  if (calculation !== null && !VALID_CALCULATIONS.includes(calculation as CalculationName)) return null;
  const year = typeof r.year === 'number' && Number.isInteger(r.year) ? r.year : null;

  return {
    ref: normalizeRef(r.ref),
    year,
    value: r.value,
    unit: r.unit,
    calculation: calculation as CalculationName | null,
    asWritten: r.asWritten,
  };
}

function coerceClaim(raw: unknown, id: string): Claim | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== 'string' || !r.text.trim()) return null;
  if (!VALID_CLAIM_TYPES.includes(r.type as Claim['type'])) return null;
  if (!Array.isArray(r.refs) || !r.refs.every(x => typeof x === 'string' && x)) return null;
  if (r.type !== 'framing' && r.refs.length === 0) return null; // refs required unless framing

  const figuresRaw = Array.isArray(r.figures) ? r.figures : [];
  const figures = figuresRaw.map(coerceFigure).filter((f): f is StatedFigure => f !== null);
  if (figures.length < figuresRaw.length) {
    console.warn(`synthesize(): dropped ${figuresRaw.length - figures.length} malformed figure(s) on claim "${id}"`);
  }

  return {
    id,
    text: r.text,
    refs: (r.refs as string[]).map(normalizeRef),
    type: r.type as Claim['type'],
    figures,
  };
}

// A cheap, deliberately conservative estimate (~4 chars/token for English) — not an exact
// tokenizer count, just enough to keep the visible answer roughly within MAX_VISIBLE_ANSWER_TOKENS
// without pulling in a real tokenizer dependency for a soft UX target, not a billing-accurate one.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/* Caps claims[] at MAX_VISIBLE_CLAIMS, then drops further trailing claims (lowest priority — the
   model was instructed to order by importance) until headline + kept claims' text estimates under
   MAX_VISIBLE_ANSWER_TOKENS. Never edits a kept claim's own text — only whole claims are
   included/excluded, so nothing a StatedFigure or quoted span was anchored to ever shifts. */
function capVisibleClaims(headline: string, claims: Claim[]): Claim[] {
  const capped = claims.slice(0, MAX_VISIBLE_CLAIMS);
  let kept = capped;
  while (kept.length > 0) {
    const tokens = estimateTokens(headline) + kept.reduce((sum, c) => sum + estimateTokens(c.text), 0);
    if (tokens <= MAX_VISIBLE_ANSWER_TOKENS) break;
    kept = kept.slice(0, -1);
  }
  return kept;
}

// Permissive, same discipline as plan.ts's toFilteredStringArray for scope/anticipatedGaps: an
// omitted or malformed headlineRefs degrades to [], never fails the whole answer. That default is
// also the SAFE one — an empty headlineRefs is vacuously trusted by verify.ts's
// computeHeadlinePublished (a headline making no specific claim has nothing to violate), so a
// model that forgets this brand-new field regresses to exactly today's unchecked behaviour,
// never to a newly-broken one.
function toRefArray(v: unknown): EvidenceRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(normalizeRef);
}

function coerceAnswer(raw: unknown): ResearchAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.headline !== 'string' || !r.headline.trim()) return null;
  if (!Array.isArray(r.claims)) return null;
  if (!Array.isArray(r.gaps) || !r.gaps.every(g => typeof g === 'string')) return null;

  const claims: Claim[] = [];
  r.claims.forEach((rawClaim, index) => {
    // Ids are assigned here, never trusted from the model (§7's "id... independent of array
    // position" is a stability guarantee code must own, not something a model can be relied on
    // to keep unique). claims.length, not index, so ids stay contiguous even if some are dropped.
    const claim = coerceClaim(rawClaim, `claim-${claims.length}`);
    if (claim) claims.push(claim);
    else console.warn(`synthesize(): dropped a structurally invalid claim at model output index ${index}`);
  });

  const visible = capVisibleClaims(r.headline, claims);
  if (visible.length < claims.length) {
    console.warn(`synthesize(): capped ${claims.length} claims to ${visible.length} for the visible-answer ceiling`);
  }

  return { headline: r.headline, headlineRefs: toRefArray(r.headlineRefs), claims: visible, gaps: r.gaps as string[] };
}

/* Shared by synthesize() and the diagnostic replay. It deliberately performs the same parse and
 * structural coercion as the live role, so replay timing includes all local synthesis work after
 * the provider response without storing model text. */
export function parseSynthesisResponse(response: {
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}): ResearchAnswer {
  const raw = parseModelJson(response.text);
  const answer = raw === null ? null : coerceAnswer(raw);
  if (answer === null) {
    throw new SynthesizeParseError(response.text, response.finishReason, response.usage?.completionTokens ?? null);
  }
  return answer;
}

export const SYNTHESIS_MODEL_OPTIONS = {
  temperature: 0,
  maxTokens: 24_000,
  timeoutMs: 120_000,
} as const;

export async function synthesize(
  compiled: CompiledEvidence,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ResearchAnswer> {
  const resolved = resolveRoleFully('synthesis');
  if (!resolved) {
    throw new SynthesizeNotConfiguredError(
      'CARIBECON_SYNTHESIS_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages = buildSynthesisMessages(compiled);

  const response = await callModel(resolved.connection, resolved.model, messages, {
    /* Raised 12000 -> 24000, this time against a REAL live failure, not a reasoned guess: a
       news-heavy question (extract_web pages now also carry structured insights, via the
       'webExtract' role — more real, verified figures competing for MAX_KEY_FACTS/
       MAX_DRIVER_ITEMS/MAX_EXTERNAL_FINDINGS than before) hit completionTokens: 12000,
       finishReason: 'length', truncated mid-figures-array on claim 4 of what would have been a
       full answer — a hard SynthesizeParseError, not a narrowed one. Doubling again follows the
       same "runaway backstop set generously above normal use" rule the 6000->12000 bump already
       used (see git history), since evidence density — and therefore how much figures[] JSON a
       claim needs — has only grown since that estimate, not shrunk.
       timeoutMs stays UNCHANGED and remains the deliberately sole binding constraint under normal
       operation: raising maxTokens cannot make a call slower on its own, it only lets a call that
       used to die mid-truncation finish instead. See interpret.ts's maxTokens comment for why
       timeouts, not tokens, are the scarce budget across this pipeline (vercel.json's 240s
       api/ask.ts ceiling). */
    ...SYNTHESIS_MODEL_OPTIONS,
    signal,
  });

  return parseSynthesisResponse(response);
}
