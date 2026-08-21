/* plan() — ARCHITECTURE.md §3.1/§3.2: "plan(intent) -> ResearchPlan." Turns a question plus its
 * already-validated ResearchIntent into a step-by-step ResearchPlan a deterministic executor
 * (Phase 3's executeResearchPlan, not built in this file) will carry out.
 *
 * Signature deliberately takes BOTH `question` and `intent`, not just `intent` as §3.1's own
 * shorthand `plan(intent)` suggests: ResearchPlan.question is documented (contracts.ts) as
 * "echoed verbatim; the auditor compares scope against it," and a raw question string cannot be
 * reliably reconstructed from the structured intent alone (free text collapses into slugs/codes
 * on the way into ResearchIntent). See the bottom of this file for how "echoed verbatim" is
 * actually guaranteed — not by asking the model to copy it.
 *
 * STRUCTURAL-ONLY VALIDATION, same split synthesize.ts documents for itself: this file checks
 * that the model's output has the right JSON shape — a real ResearchStep tool enum value, every
 * field that shape requires, unique step ids. It does NOT check whether a named country,
 * indicator, or `extract_web.onStep` reference is real. That is validateResearchPlan's job (a
 * separate function, src/lib/askTools.ts, built alongside this file in the same effort) — reusing
 * resolveCountry/resolveIndicator exactly as canonicaliseIntent already does for the Interpreter.
 * Building even a cheap version of that check here would produce two implementations of the same
 * validation that could drift apart, which is the exact failure mode both synthesize.ts and
 * ARCHITECTURE.md §2.5 warn about.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import { listCountries, listIndicators } from '../../askTools.js';
import type { ResearchIntent, ResearchPlan, ResearchStep } from '../contracts.js';

export class PlanNotConfiguredError extends Error {}

/* Distinct from a per-step structural drop (see coercePlan below) the same way
   InterpretParseError/SynthesizeParseError are distinct from their own per-item drops: this means
   the model's response could not be read as a ResearchPlan AT ALL — not even an object, or
   "steps" is not an array. A single malformed step inside an otherwise-valid plan is not this; it
   is dropped and the rest of the plan is kept, exactly like a malformed claim in synthesize.ts. */
export class PlanParseError extends Error {
  constructor(
    public readonly rawText: string,
    // Diagnostic pair carried by all three role parse errors — see api/ask.ts's
    // structuredOutputFailure() for what they distinguish and why it matters.
    public readonly finishReason: string | null = null,
    public readonly completionTokens: number | null = null,
  ) {
    super('The model did not return a parseable ResearchPlan.');
  }
}

// ── System prompt ────────────────────────────────────────────────────────────────────────────

function describeIntent(intent: ResearchIntent): string {
  return [
    `questionType: ${intent.questionType}`,
    `countries: ${intent.countries.length ? intent.countries.join(', ') : '(none identified)'}`,
    `indicators: ${intent.indicators.length ? intent.indicators.join(', ') : '(none identified)'}`,
    `yearFrom: ${intent.yearFrom ?? 'null'}`,
    `yearTo: ${intent.yearTo ?? 'null'}`,
    `newsKeywords: ${intent.newsKeywords.length ? intent.newsKeywords.join(', ') : '(none)'}`,
  ].join('\n');
}

function buildSystemPrompt(intent: ResearchIntent): string {
  const countries = listCountries()
    .map(c => `${c.code}=${c.name}`)
    .join(', ');
  const indicators = listIndicators()
    .map(i => `${i.slug}=${i.label}`)
    .join(', ');

  return [
    'You turn a Caribbean macroeconomics question, already parsed into a structured intent below,',
    'into a step-by-step research plan that a deterministic executor will carry out. You never',
    'answer the question yourself and you never invent a fact — you only decide which of five',
    'tools to call, in what order, and why.',
    '',
    'The already-parsed intent (context only; do not repeat it in your output):',
    describeIntent(intent),
    '',
    `Countries in the hub (code=name): ${countries}`,
    `Indicators in the hub (slug=label): ${indicators}`,
    '',
    'Exactly five tools exist. Every step must match one of these shapes ("tool" selects which):',
    JSON.stringify({
      id: 's1', tool: 'get_series', country: 'string', indicator: 'string',
      yearFrom: 'number|null', yearTo: 'number|null', why: 'string',
    }),
    JSON.stringify({
      id: 's2', tool: 'compare_series', countries: ['string'], indicator: 'string',
      yearFrom: 'number|null', yearTo: 'number|null', why: 'string',
    }),
    JSON.stringify({
      id: 's3', tool: 'search_news', countries: ['string'], keywords: ['string'],
      dateFrom: 'string|null', dateTo: 'string|null', why: 'string',
    }),
    JSON.stringify({
      id: 's4', tool: 'search_web', query: 'string', dateFrom: 'string|null',
      dateTo: 'string|null', why: 'string',
    }),
    JSON.stringify({
      id: 's5', tool: 'extract_web', onStep: 'string — an earlier step\'s id in THIS plan',
      maxUrls: 'number', why: 'string',
    }),
    '',
    '- get_series / compare_series / search_news: naming a country or indicator not in the lists',
    '  above is fine — it will be reported as unavailable rather than guessed, so do not avoid a',
    '  name just because you are unsure of it.',
    '- extract_web must follow a search_web step in this same plan: "onStep" must be that earlier',
    '  step\'s "id". Never invent a URL directly, and never emit extract_web with no prior',
    '  search_web step for it to reference.',
    '- Give every step a short, unique id ("s1", "s2", ...) — never reuse one.',
    '- Use the fewest steps that actually answer the question; do not add a step "for coverage".',
    '',
    'Respond with ONLY a JSON object in exactly this shape — no prose, no markdown fences, and no',
    '"question" field (the caller already has the question verbatim and supplies it itself):',
    JSON.stringify(
      {
        scope: { countries: ['string'], indicators: ['string'], yearFrom: 'number|null', yearTo: 'number|null' },
        steps: ['one of the five step shapes above'],
        anticipatedGaps: ['string — things you expect the evidence below might not cover'],
      },
      null,
      2,
    ),
  ].join('\n');
}

// ── Structural validation only — see the file header for why real-name checks are NOT here ────

const VALID_TOOLS: readonly ResearchStep['tool'][] = [
  'get_series', 'compare_series', 'search_news', 'search_web', 'extract_web',
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// All-or-nothing, same discipline coerceClaim (synthesize.ts) applies to Claim.refs: a step's own
// subject list (which countries to compare, which keywords to search) is central to what the
// step actually does, so one bad entry invalidates the whole array rather than being silently
// dropped — a comparison silently losing one of its two countries is a worse outcome than
// dropping the step entirely and letting validateResearchPlan / the executor report the gap.
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim().length > 0);
}

// Permissive, mirrors coerceFigure's `year` handling in synthesize.ts: these fields are all
// nullable in the ResearchStep union, so a malformed value degrades to null rather than dropping
// the whole step — only a tool's own required subject fields (country, indicator, query, onStep,
// maxUrls, the subject arrays above) cause a drop.
function toNullableYear(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function toNullableDateString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function coerceStep(raw: unknown): ResearchStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.id)) return null;
  if (!isNonEmptyString(r.why)) return null;
  if (typeof r.tool !== 'string' || !VALID_TOOLS.includes(r.tool as ResearchStep['tool'])) return null;

  switch (r.tool as ResearchStep['tool']) {
    case 'get_series': {
      if (!isNonEmptyString(r.country) || !isNonEmptyString(r.indicator)) return null;
      return {
        id: r.id, tool: 'get_series', country: r.country, indicator: r.indicator,
        yearFrom: toNullableYear(r.yearFrom), yearTo: toNullableYear(r.yearTo), why: r.why,
      };
    }
    case 'compare_series': {
      if (!isStringArray(r.countries) || !isNonEmptyString(r.indicator)) return null;
      return {
        id: r.id, tool: 'compare_series', countries: r.countries, indicator: r.indicator,
        yearFrom: toNullableYear(r.yearFrom), yearTo: toNullableYear(r.yearTo), why: r.why,
      };
    }
    case 'search_news': {
      if (!isStringArray(r.countries) || !isStringArray(r.keywords)) return null;
      return {
        id: r.id, tool: 'search_news', countries: r.countries, keywords: r.keywords,
        dateFrom: toNullableDateString(r.dateFrom), dateTo: toNullableDateString(r.dateTo), why: r.why,
      };
    }
    case 'search_web': {
      if (!isNonEmptyString(r.query)) return null;
      return {
        id: r.id, tool: 'search_web', query: r.query,
        dateFrom: toNullableDateString(r.dateFrom), dateTo: toNullableDateString(r.dateTo), why: r.why,
      };
    }
    case 'extract_web': {
      if (!isNonEmptyString(r.onStep)) return null;
      if (typeof r.maxUrls !== 'number' || !Number.isInteger(r.maxUrls) || r.maxUrls < 1) return null;
      return { id: r.id, tool: 'extract_web', onStep: r.onStep, maxUrls: r.maxUrls, why: r.why };
    }
    /* istanbul ignore next -- unreachable: r.tool was already checked against VALID_TOOLS above */
    default:
      return null;
  }
}

// scope/anticipatedGaps are ancillary context, not the plan's substance (the steps are) — a
// malformed entry inside either is filtered out (same permissive style askTools.toStringArray
// already uses for AskIntent), never enough on its own to fail the whole plan. Only "the response
// isn't an object" or "steps isn't an array" invalidate the plan outright (see coercePlan).
function toFilteredStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function coerceScope(raw: unknown): ResearchPlan['scope'] {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    countries: toFilteredStringArray(r.countries),
    indicators: toFilteredStringArray(r.indicators),
    yearFrom: toNullableYear(r.yearFrom),
    yearTo: toNullableYear(r.yearTo),
  };
}

/* Returns everything ResearchPlan needs EXCEPT `question` — plan() below always supplies that
   itself from its own parameter (see the file header: "echoed verbatim" is a guarantee code must
   own, not something a model can be trusted to reproduce character-for-character, the same
   reasoning synthesize.ts applies to Claim.id). Returns null only when the response cannot be
   read as a plan at all; a malformed individual step is dropped in place, not a reason to fail
   the whole thing. */
function coercePlan(raw: unknown): Omit<ResearchPlan, 'question'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.steps)) return null;

  const seenIds = new Set<string>();
  const steps: ResearchStep[] = [];
  r.steps.forEach((rawStep, index) => {
    const step = coerceStep(rawStep);
    if (!step) {
      console.warn(`plan(): dropped a structurally invalid step at model output index ${index}`);
      return;
    }
    if (seenIds.has(step.id)) {
      console.warn(`plan(): dropped step "${step.id}" at model output index ${index} — duplicate id`);
      return;
    }
    seenIds.add(step.id);
    steps.push(step);
  });

  return { scope: coerceScope(r.scope), steps, anticipatedGaps: toFilteredStringArray(r.anticipatedGaps) };
}

export async function plan(question: string, intent: ResearchIntent): Promise<ResearchPlan> {
  const resolved = resolveRoleFully('plan');
  if (!resolved) {
    throw new PlanNotConfiguredError(
      'CARIBECON_PLAN_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(intent) },
    { role: 'user', content: question },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* Raised 4000 -> 8000. See interpret.ts's maxTokens comment for the governing rule (a runaway
       backstop set above normal use, never a size estimate) — this role adopts the same floor for
       the same reason. The previous 4000 described itself as "a reasonable middle starting point;
       revisit with a live capture... if it proves too tight in practice"; this is that revisit.
       A plan's JSON has real internal structure (several steps, each a discriminated-union object
       with its own required fields) versus interpret's single flat object, and thinking stays ON
       here too, so the reasoning trace — not the plan itself — is what consumes the budget.
       timeoutMs stays 30s: wall clock, not tokens, is the constrained budget (interpret.ts). */
    maxTokens: 8_000,
    timeoutMs: 30_000,
  });

  const raw = parseModelJson(response.text);
  const coerced = raw === null ? null : coercePlan(raw);
  if (coerced === null) {
    throw new PlanParseError(response.text, response.finishReason, response.usage?.completionTokens ?? null);
  }

  // `question` is always the caller's own parameter, never the model's copy of it — see the file
  // header and coercePlan's own comment for why.
  return { question, ...coerced };
}
