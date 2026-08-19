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
  constructor(public readonly rawText: string) {
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

const ANALYST_INSTRUCTIONS = [
  'You are an economic analyst reasoning over an already-curated evidence package, not a',
  'summarizer restating it. Your job is to answer the actual question, not enumerate every',
  'retrieved fact.',
  '',
  '- Determine the 2-4 most important conclusions the evidence supports.',
  '- Explain the economic mechanisms that best account for what the evidence shows.',
  '- Use quantitative evidence to defend those explanations — numbers support analysis, they do',
  '  not replace it.',
  '- Distinguish what is directly observed in the evidence from what is plausible inference.',
  '  State uncertainty clearly when an explanation is plausible but not directly proven.',
  '- Do not enumerate every retrieved fact, and do not repeat evidence unless it advances the',
  '  explanation of why something happened.',
  '- Prioritize explanation over evidence recitation: what happened, why it likely happened, the',
  '  mechanism, the supporting evidence, what remains uncertain — not a list of facts followed by',
  '  a limitations paragraph.',
  '- Explain economic relationships in clear, interpretable language; when a technical concept is',
  '  useful, explain it naturally rather than assuming the reader already knows the term.',
  '- Use the strongest available evidence and ignore low-value evidence that would not materially',
  '  improve the answer — you do not need to use everything you were given.',
  '- Do not manufacture a causal explanation where the evidence does not support one.',
  '- Keep gaps/limitations terse — a short analytical note on what remains uncertain, not an',
  '  audit of every source\'s metadata; the evidence note shown to the user is built separately,',
  '  deterministically, from what was actually retrieved.',
].join('\n');

function buildSystemPrompt(compiled: CompiledEvidence): string {
  const sections: string[] = [
    ANALYST_INSTRUCTIONS,
    '',
    `Question: ${compiled.question}`,
    `Analysis goal: ${compiled.analysisGoal}`,
    '',
    "KEY FACTS (each item's ref(s) shown — cite one exactly, never invent one):",
    ...(compiled.keyFacts.length ? compiled.keyFacts.map(describeItem) : ['(none retrieved)']),
  ];

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
    '- Every number in a claim\'s "text" must have a matching entry in that claim\'s "figures[]"',
    '  — never state a number that is not declared as a figure.',
    '- "calculation" must be null (a raw/reported value) or exactly one of the pre-computed values',
    '  shown above for that ref — never compute your own change or average.',
    '- Only cite a ref shown above. Never invent one.',
    '- A concept item (marked "no ref") may back only a "context" or "framing" claim, never a',
    '  figure — the same restriction a W: item with no extract is already held to.',
    '- "refs" may be empty ONLY when type is "framing" (general commentary, no specific evidence',
    '  tie). Every other claim needs at least one ref.',
    '- Respect every caveat above exactly as written — it is a constraint, not a suggestion.',
    '- Order your claims by importance — the most important conclusion first. If your answer runs',
    '  long, only the leading claims are guaranteed to be shown.',
  );

  return sections.join('\n');
}

// ── Structural validation only — see the file header for why grounding checks are NOT here ──

const VALID_CLAIM_TYPES: readonly Claim['type'][] = ['figure', 'trend', 'context', 'framing'];
const VALID_CALCULATIONS: readonly CalculationName[] = ['yoy_change', 'pp_change', 'period_average'];

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
    ref: r.ref as EvidenceRef,
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

  return { id, text: r.text, refs: r.refs as EvidenceRef[], type: r.type as Claim['type'], figures };
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

  return { headline: r.headline, claims: visible, gaps: r.gaps as string[] };
}

export async function synthesize(compiled: CompiledEvidence): Promise<ResearchAnswer> {
  const resolved = resolveRoleFully('synthesis');
  if (!resolved) {
    throw new SynthesizeNotConfiguredError(
      'CARIBECON_SYNTHESIS_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(compiled) },
    { role: 'user', content: 'Write the research answer now, following the rules and shape exactly.' },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* Stage D — measured live, not assumed. Two real end-to-end runs against the new compact
       CompiledEvidence prompt (Nebius interpret/plan/execute + MiniMax synthesize, one
       news-heavy, one comparison-heavy): completionTokens 1836 and 2095 — comfortably under
       6000 (3x+ headroom) despite one genuinely evidence-rich case. 12000 was never earned by
       real usage; it was the emergency fix for the OLD raw-evidence-dump prompt's parse
       failures, carried forward unmeasured through Stage C. timeoutMs keeps real margin above
       the slower of the two observed synthesis times (43-45s) — the two runs used near-identical
       compiled input size yet differed 3x in wall-clock time (13s vs 43-45s), which points to
       provider-side variance, not prompt size, as the dominant latency factor; a token cut alone
       is not expected to reliably buy latency, only a tighter safety margin. Re-measure before
       cutting further — this is two live samples, not a large one. */
    maxTokens: 6_000,
    timeoutMs: 90_000,
  });

  const raw = parseModelJson(response.text);
  const answer = raw === null ? null : coerceAnswer(raw);
  if (answer === null) {
    throw new SynthesizeParseError(response.text);
  }
  return answer;
}
