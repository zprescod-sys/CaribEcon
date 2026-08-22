/* routePlan() — the merged Interpret+Plan role (plans/interpret-plan-merge-latency-review.md).
 * One model call that does what interpret() + plan() used to do sequentially: read the question
 * (+ history), resolve entities into an intent, AND produce the step-by-step research plan a
 * deterministic executor will carry out.
 *
 * Only reachable when CARIBECON_ROUTE_MODE=combined (research.ts). The default (unset, or any
 * other value) still runs interpret()+plan() as two calls — this file is additive, not a
 * replacement, so that path is a config flip away, no redeploy.
 *
 * DELIBERATELY REUSES, NOT REIMPLEMENTS, every deterministic validator the staged path already
 * has: canonicaliseIntent() (askTools.ts) for the interpretation half, coercePlan() (plan.ts,
 * exported for exactly this reuse) for the plan half. This file's only real job is building one
 * combined prompt and parsing one combined response into the two shapes those functions already
 * know how to check — see contracts.ts's "map before you build" warning, which is exactly why
 * neither validator is duplicated here.
 *
 * The catalog (19 countries, 24 indicators) and the five tool shapes are each sent to the model
 * exactly ONCE per request — under interpret()+plan() they were sent twice (once per call). Same
 * for history: interpret() reads it, plan() never did (its prompt has no history section at
 * all), so a pronoun-resolving follow-up question ("what about its unemployment rate?") relied
 * entirely on interpret()'s own resolution reaching plan() through the already-resolved intent
 * text. That still works here — describeHistory() below is reused verbatim.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import { canonicaliseIntent, listCountries, listIndicators, type RetrievalMiss } from '../../askTools.js';
import { coercePlan } from './plan.js';
import type { ConversationTurn, ResearchIntent, ResearchPlan } from '../contracts.js';

export class RoutePlanNotConfiguredError extends Error {}

/* Distinct from a RetrievalMiss the same way InterpretParseError/PlanParseError are distinct from
 * theirs: this means the model's response could not be read as {interpretation, plan} at ALL —
 * not even an object, or one of the two halves is missing/not an object. A malformed individual
 * plan step is NOT this; it is dropped in place by coercePlan(), exactly as it is today. */
export class RoutePlanParseError extends Error {
  constructor(
    public readonly rawText: string,
    // Same diagnostic pair as every other role parse error — api/ask.ts's structuredOutputFailure().
    public readonly finishReason: string | null = null,
    public readonly completionTokens: number | null = null,
  ) {
    super('The model did not return a parseable {interpretation, plan} response.');
  }
}

export interface RoutePlanResult {
  intent: ResearchIntent;
  misses: RetrievalMiss[];
  plan: ResearchPlan;
  /* Diagnostic metadata, additive — research.ts ignores both. Extends to the success path the
     same transparency ParseError already carries for the failure path (finishReason/
     completionTokens), so token spend on this now-doing-two-jobs-at-once call is observable
     without a separate instrumentation layer. */
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  finishReason: string | null;
}

// Identical to interpret.ts's own describeHistory — duplicated rather than imported, since
// interpret.ts is the rollback path and must stay independently correct/removable without this
// file breaking (see the migration note in the plan doc: retire interpret.ts/plan.ts only after
// CARIBECON_ROUTE_MODE=combined has burned in, as their own, separate step).
function describeHistory(history: ConversationTurn[]): string[] {
  return history.map(
    (turn, i) =>
      `${i + 1}. Q: "${turn.question}" — refs: ${turn.refs.length ? turn.refs.join(', ') : '(none)'} — answered: "${turn.headline}"`,
  );
}

function buildSystemPrompt(history: ConversationTurn[]): string {
  const countries = listCountries()
    .map(c => `${c.code}=${c.name}`)
    .join(', ');
  const indicators = listIndicators()
    .map(i => `${i.slug}=${i.label}`)
    .join(', ');

  const sections = [
    'You turn a question about Caribbean macroeconomics into TWO things at once, in one JSON',
    'response: a structured interpretation of the question, and a step-by-step research plan a',
    'deterministic executor will carry out. You never answer the question yourself, and naming a',
    'country or indicator that is not in the lists below is fine — it will be reported as',
    'unavailable rather than guessed, so do not avoid a name just because you are unsure of it.',
    'You never invent a fact — you only decide what the question is about, and which of five',
    'tools to call, in what order, and why.',
  ];

  if (history.length) {
    sections.push(
      '',
      'RECENT CONVERSATION (oldest first) — use this ONLY to resolve a pronoun or omission in the',
      'new question below ("their", "that country", "now", "what about exports instead"). The new',
      'question is authoritative: if it already names its own country or indicator, IGNORE the',
      'conversation below entirely rather than blend the two — never let an earlier topic leak',
      'into a question that did not ask about it. This resolution applies to BOTH the',
      'interpretation and the plan below — a plan step must name the SAME resolved country/',
      'indicator the interpretation does, not re-introduce the ambiguity the interpretation just',
      'resolved.',
      ...describeHistory(history),
    );
  }

  sections.push(
    '',
    `Countries in the hub (code=name): ${countries}`,
    `Indicators in the hub (slug=label): ${indicators}`,
    '',
    '── Part 1: interpretation ──',
    'A structured read of the question as a whole:',
    '{"questionType":"indicator"|"comparison"|"news","countries":string[],"indicators":string[],"yearFrom":number|null,"yearTo":number|null,"newsKeywords":string[]}',
    '- "comparison" is for comparing 2+ economies on one indicator.',
    '- "news" is for questions about recent events, not a specific data series.',
    '- Either the code or the name resolves for a country — use whichever the question used.',
    '- yearFrom/yearTo are null unless the question names a specific year or range.',
    '- newsKeywords are only used for "news" questions: short terms, not the question restated.',
    '',
    '── Part 2: plan ──',
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
    '- extract_web must follow a search_web step in this same plan: "onStep" must be that earlier',
    '  step\'s "id". Never invent a URL directly, and never emit extract_web with no prior',
    '  search_web step for it to reference.',
    '- Give every step a short, unique id ("s1", "s2", ...) — never reuse one.',
    '- Use the fewest steps that actually answer the question; do not add a step "for coverage".',
    '  A plain factual question about one country and one indicator needs exactly one get_series',
    '  step — do not add search_news or search_web just because they exist.',
    '- Only add search_news/search_web/extract_web when the question genuinely needs recent',
    '  events, context, or qualitative research the internal hub data cannot answer alone.',
    '',
    'Respond with ONLY a JSON object in exactly this shape — no prose, no markdown fences:',
    JSON.stringify(
      {
        interpretation: {
          questionType: 'indicator|comparison|news', countries: ['string'], indicators: ['string'],
          yearFrom: 'number|null', yearTo: 'number|null', newsKeywords: ['string'],
        },
        plan: {
          scope: { countries: ['string'], indicators: ['string'], yearFrom: 'number|null', yearTo: 'number|null' },
          steps: ['one of the five step shapes above'],
          anticipatedGaps: ['string — things you expect the evidence below might not cover'],
        },
      },
      null,
      2,
    ),
    '(no "question" field anywhere — the caller already has the question verbatim and supplies it',
    'itself.)',
  );

  return sections.join('\n');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export async function routePlan(question: string, history: ConversationTurn[] = []): Promise<RoutePlanResult> {
  const resolved = resolveRoleFully('routePlan');
  if (!resolved) {
    throw new RoutePlanNotConfiguredError(
      'CARIBECON_ROUTEPLAN_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(history) },
    { role: 'user', content: question },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* Same runaway-backstop rule as every other JSON role (interpret.ts's canonical rationale).
       This call now does two roles' worth of reasoning + output in one completion — plan.ts alone
       already needed 8000, interpret.ts's own single flat object needed 8000 too once its
       reasoning trace was measured live. Doubling to 16000 rather than assuming the sum is a
       reasoned starting point, not a live measurement — the whole point of the benchmark this
       role was built for is to replace this guess with a real one before CARIBECON_ROUTE_MODE
       defaults to combined. timeoutMs: interpret+plan together consumed up to 50s of ceiling
       (20s+30s) sequentially; a single call doing the same combined work gets 45s — slightly under
       the sum, since there is no second connection/queue wait to add on top. */
    maxTokens: 16_000,
    timeoutMs: 45_000,
  });

  const raw = parseModelJson(response.text);
  if (!isPlainObject(raw) || !isPlainObject(raw.interpretation) || !('plan' in raw)) {
    throw new RoutePlanParseError(response.text, response.finishReason, response.usage?.completionTokens ?? null);
  }

  const coercedPlan = coercePlan(raw.plan);
  if (coercedPlan === null) {
    throw new RoutePlanParseError(response.text, response.finishReason, response.usage?.completionTokens ?? null);
  }

  const { intent, misses } = canonicaliseIntent(raw.interpretation);

  // `question` is always the caller's own parameter, never the model's copy of it — same
  // discipline plan()/coercePlan() already document for exactly this reason.
  return {
    intent,
    misses,
    plan: { question, ...coercedPlan },
    usage: response.usage,
    finishReason: response.finishReason,
  };
}
