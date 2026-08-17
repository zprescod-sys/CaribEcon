/* synthesize() — ARCHITECTURE.md §3.1: "synthesize(intent, pkg) -> ResearchAnswer." Turns
 * validated evidence into a claim-structured answer: a headline, a list of Claims, and a list
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
 * applied here to behaviour instead.
 *
 * Per the plan's own caution for this phase: this function's output is internal-only. Nothing
 * here has been checked against the evidence yet, so it must not be shown to anyone as a
 * finished answer until Phase 2's gate exists.
 *
 * The one deliberate de-risking move beyond bare structural validation: derived figures
 * (year-over-year change, period average) are PRE-COMPUTED here using the same
 * calculations.ts functions api/deepdive.ts already relies on, and handed to the model as
 * evidence rather than left for the model to calculate itself. Citing a given number is far
 * safer than asking a model to do arithmetic and hoping it is right — and it costs nothing new,
 * since yoy_change/pp_change/period_average already exist, are pure, and are already tested.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import { evidenceId, type EvidencePackage, type DataEvidence } from '../../askTools.js';
import { calculationForUnit } from '../../excelOutputs.js';
import { yoy_change, pp_change, period_average } from '../../calculations.js';
import type { ResearchIntent, ResearchAnswer, Claim, StatedFigure, EvidenceRef, CalculationName } from '../contracts.js';

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

// ── Restating the question from structured intent (no raw NL question in this signature) ──

function yearRange(intent: ResearchIntent): string {
  if (intent.yearFrom !== null && intent.yearTo !== null) return `, ${intent.yearFrom}-${intent.yearTo}`;
  if (intent.yearFrom !== null) return `, from ${intent.yearFrom}`;
  if (intent.yearTo !== null) return `, through ${intent.yearTo}`;
  return '';
}

function describeIntent(intent: ResearchIntent): string {
  const countries = intent.countries.length ? intent.countries.join(', ') : 'the region';
  const indicators = intent.indicators.length ? intent.indicators.join(', ') : 'the requested indicator';

  if (intent.questionType === 'comparison') {
    return `Question: compare ${indicators} across ${countries}${yearRange(intent)}.`;
  }
  if (intent.questionType === 'news') {
    const kw = intent.newsKeywords.length ? ` about: ${intent.newsKeywords.join(', ')}` : '';
    return `Question: recent news for ${countries}${kw}.`;
  }
  return `Question: ${indicators} for ${countries}${yearRange(intent)}.`;
}

// ── Evidence context, with derived figures pre-computed rather than left to the model ──────

function describeSeries(d: DataEvidence): string {
  const ref = `D:${evidenceId(d.country, d.indicator)}`;
  const calcName: CalculationName = calculationForUnit(d.unit);
  const changes = (calcName === 'pp_change' ? pp_change : yoy_change)(d.points);
  const avg = period_average(d.points);

  const pointLines = d.points
    .map(p => `    ${p.year}: ${p.value === null ? 'no data' : p.value} (${p.type})`)
    .join('\n');
  const changeLines = changes
    .filter(c => c.value !== null)
    .map(c => `    ${c.year}: ${(c.value as number).toFixed(2)} [${calcName}, from years ${c.inputYears.join(', ')}]`)
    .join('\n');

  const lines = [
    `${ref} — ${d.label} (${d.unit}), source: ${d.sourceOrg}${d.note ? `. Note: ${d.note}` : ''}`,
    '  Retrieved points:',
    pointLines,
  ];
  if (changeLines) lines.push(`  Pre-computed ${calcName}:`, changeLines);
  if (avg.value !== null) {
    lines.push(`  Period average: ${avg.value.toFixed(2)} [period_average, years ${avg.inputYears.join(', ')}]`);
  }
  return lines.join('\n');
}

function buildSystemPrompt(intent: ResearchIntent, pkg: EvidencePackage): string {
  const sections: string[] = [
    'You write a grounded research answer about Caribbean macroeconomics from the evidence ' +
      'given below, and nothing else. You never state a number, country, or indicator that is ' +
      'not explicitly given to you here — anything you are not given, you must not claim to ' +
      'know, even if you believe you do. Report what the evidence does not cover in "gaps" ' +
      'rather than filling it in.',
    '',
    describeIntent(intent),
    '',
    "EVIDENCE (each item's stable ID is shown — cite it exactly, never invent one):",
    '',
    ...pkg.data.map(describeSeries),
    ...pkg.news.map(n => `N:${n.id} — "${n.title}" (${n.source}, ${n.date}) [${n.country}]`),
  ];

  if (pkg.caveats.length) {
    sections.push('', 'CAVEATS — hard constraints, not suggestions:', ...pkg.caveats.map(c => `- ${c}`));
  }
  if (pkg.misses.length) {
    sections.push(
      '',
      'KNOWN GAPS — retrieval could not cover these; report honestly in "gaps", do not guess:',
      ...pkg.misses.map(m => `- ${m.detail}`),
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
    '- "calculation" must be null (a raw retrieved value) or exactly one of the pre-computed',
    '  values shown above for that ref — never compute your own change or average.',
    '- Only cite a ref shown above. Never invent one.',
    '- "refs" may be empty ONLY when type is "framing" (general commentary, no specific evidence',
    '  tie). Every other claim needs at least one ref.',
    '- Respect every caveat above exactly as written — it is a constraint, not a suggestion.',
    '- Be concise and specific — a research note, not an essay.',
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

  return { headline: r.headline, claims, gaps: r.gaps as string[] };
}

export async function synthesize(intent: ResearchIntent, pkg: EvidencePackage): Promise<ResearchAnswer> {
  const resolved = resolveRoleFully('synthesis');
  if (!resolved) {
    throw new SynthesizeNotConfiguredError(
      'CARIBECON_SYNTHESIS_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(intent, pkg) },
    { role: 'user', content: 'Write the research answer now, following the rules and shape exactly.' },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* Deliberately generous, and higher than interpret's on both counts. Thinking stays ON for
       this role by design — synthesis is the harder task (turning evidence into grounded
       claims) and is worth letting the model reason fully for, especially once Phase 3 adds
       Tavily and there is genuinely more to weigh. MiniMax-M3 was observed live spending ~290
       reasoning tokens and ~8s on a trivial prompt; a real synthesis with several data series
       needs headroom for both a longer reasoning phase AND the answer itself (headline +
       several claims + figures). Raised from 40s to 90s after a live capture run
       (src/lib/ai/fixtures/askCaptures.json, "news_current_context") hit a real 46.5s
       MiniMax response that the old cap cut off. */
    maxTokens: 6000,
    timeoutMs: 90_000,
  });

  const raw = parseModelJson(response.text);
  const answer = raw === null ? null : coerceAnswer(raw);
  if (answer === null) {
    throw new SynthesizeParseError(response.text);
  }
  return answer;
}
