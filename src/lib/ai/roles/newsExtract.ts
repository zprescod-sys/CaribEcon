/* extractArticleInsights() — the 'newsExtract' role (docs/ARCHITECTURE.md's news-digest side path,
 * plan §2h; restructured by the Synthesis Latency + Evidence Compiler upgrade, Stage A).
 *
 * Turns already-fetched article text into STRUCTURED economic insight — keyClaims,
 * importantFigures, economicDrivers, relevantContext, topics — replacing the earlier plain-prose
 * summary. This is what the Evidence Compiler (Stage B) consumes to build compact driver/context
 * evidence, instead of a synthesizer re-deriving "why this article matters economically" from a
 * paragraph on every request.
 *
 * The model is asked for ONLY what it can't already know deterministically. articleId, source,
 * publishedAt, and url are already known to the caller (the executor has the News Hub item's own
 * metadata before it ever calls this role) — asking the model to reproduce them would spend
 * tokens and add a hallucination surface for zero benefit. Same reasoning plan.ts already applies
 * to ResearchPlan.question: code assigns what code already has, never trusts a model to echo it
 * back faithfully.
 *
 * The one deliberate exception: each importantFigures entry DOES ask the model for that figure's
 * own country. The article's overall country is caller-known, but which country a SPECIFIC figure
 * is about is not reliably the same thing — an article primarily about one country can still cite
 * a figure for another, and defaulting every figure to the article's subject would mis-tag exactly
 * that case (the alternative this was weighed against and rejected). This is genuine inference,
 * not lookup, so it is scoped and hedged like textPresenceVerified below, not treated as fact:
 * newsExtract.ts resolves the model's raw country string through askTools.ts's resolveCountry()
 * before it goes anywhere near the Evidence Compiler, and an unresolved or omitted answer becomes
 * `country: null`, never a guess.
 *
 * Structurally this still mirrors interpret.ts's pattern: resolveRoleFully('newsExtract'), one
 * callModel call at temperature 0, no tool loop — now through parseModelJson like every other
 * structured role, instead of taking response.text as prose.
 *
 * ── Fail-soft contract, unchanged by this restructure ──
 * Every other role (interpret/plan/synthesis/verify) throws a *NotConfiguredError when
 * unconfigured, which fails the whole request — correct for them, since each is a hard pipeline
 * dependency. extractArticleInsights() is NOT: it is a genuinely optional enrichment step, not a
 * new hard dependency for /api/ask. This function NEVER THROWS. It returns null when: the role is
 * unconfigured, the model call fails (network/timeout/ProviderCallError), or the response can't be
 * parsed into the expected shape. The CALLER (the executor) treats null as "no insights available,
 * proceed without them" — it still has the raw fetched text to put into evidence unenriched.
 *
 * ── textPresenceVerified is NOT a grounding verdict — read this before using the field anywhere ──
 * verifyImportantFigures() below checks whether a figure's numeric value is textually present
 * SOMEWHERE in the real article text, reusing figureMatches/NUMBER_PATTERN — the same primitives
 * grounding.ts's web_figure_reconciliation uses. That proves co-occurrence, not correctness: it
 * cannot confirm the number is actually the one attached to the claimed metric/country/period,
 * only that it wasn't invented outright. A figure that fails even this weak check is dropped
 * entirely (an outright fabrication, not merely "unverified"); one that passes keeps
 * textPresenceVerified: true and is STILL subject to the real check — web_figure_reconciliation,
 * at the final grounding gate, the one time any of this actually gets checked against a claim a
 * synthesizer chose to cite.
 */
import { resolveRoleFully, type Role } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import { figureMatches, NUMBER_PATTERN } from '../grounding.js';
import { resolveCountry } from '../../askTools.js';
import type { ArticleInsights, ImportantFigure, EconomicDriver } from '../contracts.js';

const SYSTEM_PROMPT = [
  'You extract the economically relevant substance of a real news article for a research',
  "analyst's internal use. State only what the article itself says — never add outside",
  'knowledge, speculation, or opinion. If the text is truncated or unclear, extract only what',
  'is legible.',
  '',
  'Respond with ONLY a JSON object in exactly this shape — no prose, no markdown fences:',
  JSON.stringify(
    {
      keyClaims: ['string — a factual claim the article makes'],
      importantFigures: [
        {
          metric: 'string',
          value: 'string, as written, e.g. "16.2%"',
          period: 'string, e.g. "2026" or "Q2 2026"',
          country: 'string or null — the country THIS figure is about, or null if unclear',
        },
      ],
      economicDrivers: [
        {
          driver: 'string',
          mechanism: 'string — how the driver leads to the outcome',
          evidence: 'string — what in the article supports this',
          confidence: '"high"|"medium"|"low"',
        },
      ],
      relevantContext: ['string — background context, not a claim or figure'],
      topics: ['string — short topic tags, e.g. "inflation", "fiscal_policy"'],
    },
    null,
    2,
  ),
  '',
  'Do not include articleId, source, publishedAt, or url — the caller already has these.',
  'Every figure in importantFigures must actually appear in the article text as written there —',
  'never invent a number the article does not state.',
  '',
  "For each figure's country: read the sentence and surrounding paragraph the figure itself",
  "appears in, not just the article's general subject. An article mainly about one country can",
  'still cite a figure for another — attribute each figure to the country IT is actually about,',
  "even when that differs from the article's main subject. If the text genuinely does not make a",
  'figure\'s country clear, use null rather than guessing.',
].join('\n');

export interface ArticleContext {
  title: string;
  text: string;
  publishedDate: string | null;
}

function buildUserContent(article: ArticleContext): string {
  return [
    `Title: ${article.title}`,
    `Published: ${article.publishedDate ?? 'unknown'}`,
    '',
    'Article text:',
    article.text,
  ].join('\n');
}

// Structural coercion only — mirrors synthesize.ts's coerceClaim/coerceAnswer discipline: drop a
// malformed entry, keep the rest, never throw over one bad item in an otherwise-usable response.
// `country` is resolved through resolveCountry(), never passed through raw — see ImportantFigure's
// own doc comment for why an unresolved model string must become null, not a silently-broken key.
function coerceFigure(raw: unknown): Omit<ImportantFigure, 'textPresenceVerified'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.metric !== 'string' || !r.metric.trim()) return null;
  if (typeof r.value !== 'string' || !r.value.trim()) return null;
  if (typeof r.period !== 'string' || !r.period.trim()) return null;
  const country = typeof r.country === 'string' ? resolveCountry(r.country) : null;
  return { metric: r.metric, value: r.value, period: r.period, country };
}

const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

function coerceDriver(raw: unknown): EconomicDriver | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.driver !== 'string' || !r.driver.trim()) return null;
  if (typeof r.mechanism !== 'string' || !r.mechanism.trim()) return null;
  if (typeof r.evidence !== 'string' || !r.evidence.trim()) return null;
  const confidence = typeof r.confidence === 'string' && VALID_CONFIDENCE.has(r.confidence) ? r.confidence : 'low';
  return { driver: r.driver, mechanism: r.mechanism, evidence: r.evidence, confidence: confidence as EconomicDriver['confidence'] };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

interface CoercedInsights {
  keyClaims: string[];
  figures: Omit<ImportantFigure, 'textPresenceVerified'>[];
  drivers: EconomicDriver[];
  relevantContext: string[];
  topics: string[];
}

function coerceRaw(raw: unknown): CoercedInsights | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const figuresRaw = Array.isArray(r.importantFigures) ? r.importantFigures : [];
  const driversRaw = Array.isArray(r.economicDrivers) ? r.economicDrivers : [];
  return {
    keyClaims: toStringArray(r.keyClaims),
    figures: figuresRaw.map(coerceFigure).filter((f): f is Omit<ImportantFigure, 'textPresenceVerified'> => f !== null),
    drivers: driversRaw.map(coerceDriver).filter((d): d is EconomicDriver => d !== null),
    relevantContext: toStringArray(r.relevantContext),
    topics: toStringArray(r.topics),
  };
}

/* Sets textPresenceVerified by checking whether `value`'s numeric content is textually present
   ANYWHERE in the real article text — a weak, early filter, not grounding (see the file header).
   A figure whose value can't be located in the text at all is dropped outright, not flagged false:
   an unfindable number is a stronger claim ("not in the source") than this function exists to make
   cautiously, so it removes it rather than passing it on with a misleading flag. Exported so it's
   independently testable without a model call. */
export function verifyImportantFigures(
  figures: Omit<ImportantFigure, 'textPresenceVerified'>[],
  articleText: string,
): ImportantFigure[] {
  const candidates = [...articleText.matchAll(NUMBER_PATTERN)].map(m => Number(m[0].replace(/,/g, '')));
  const verified: ImportantFigure[] = [];
  for (const figure of figures) {
    const stated = Number(figure.value.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(stated)) continue; // couldn't even parse a number out of what the model wrote
    // Sign-insensitive, same convention checkUnstatedNumber/checkWebFigureReconciliation already
    // use (grounding.ts): prose describing a decline often carries no literal minus sign, and
    // figureMatches itself does not apply Math.abs internally — the caller must, on both sides.
    const found = candidates.some(actual => figureMatches(Math.abs(stated), Math.abs(actual), figure.value));
    if (found) verified.push({ ...figure, textPresenceVerified: true });
    // else: not found anywhere in the source text — dropped, not flagged false; see header above.
  }
  return verified;
}

/* Returns structured insights, or null if enrichment could not happen for any reason — see the
   fail-soft contract in the file header. Never throws.

   `role` selects which provider/model config to resolve — 'newsExtract' (default) for the
   search_news digest path, 'webExtract' for the extract_web/Tavily path (executor.ts). Same
   prompt, same coercion, same fail-soft contract either way; only the underlying model differs,
   since the two paths can run at different concurrency and warrant independently-tuned models
   (CARIBECON_NEWSEXTRACT_* vs CARIBECON_WEBEXTRACT_*). */
export async function extractArticleInsights(
  article: ArticleContext,
  role: Role = 'newsExtract',
  { signal }: { signal?: AbortSignal } = {},
): Promise<ArticleInsights | null> {
  const resolved = resolveRoleFully(role);
  if (!resolved) return null;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(article) },
  ];

  let responseText: string;
  try {
    const response = await callModel(resolved.connection, resolved.model, messages, {
      temperature: 0,
      /* Measured live against real Caribbean news articles, not assumed. The configured model
         (a reasoning model) writes its full chain-of-thought into a separate `reasoning` field
         BEFORE it ever writes the JSON answer into `content` — distinct from the <think>-in-
         content pattern stripThinking() (openaiCompatible.ts) already handles, and NOT something
         this call can see or budget around; only the total token count is controllable here. At
         the original 800, real articles measured 0% success (finish_reason: "length" every time,
         content empty — the reasoning trace alone exceeded the budget). Sweeping 2000/4000/6000/
         10000 against 6 real fetched articles: 6000 reached 80% success, 10000 resolved the one
         remaining holdout at 17.1s. 8000 splits that with real margin. Successful-call latency
         does not scale with the cap itself — a call that only needs 1500 tokens finishes just as
         fast at an 8000 cap as at a 2000 one; the cap only matters for calls that would otherwise
         truncate. Candidates in a digest batch run concurrently (Promise.all in executor.ts), so
         this is the per-call ceiling, not a per-request multiplier. timeoutMs keeps real margin
         above the worst completion observed (17-18s). */
      maxTokens: 16_000,
      timeoutMs: 45_000,
      signal,
    });
    responseText = response.text;
  } catch {
    return null; // network error, timeout, or provider error — swallow, not propagate
  }

  const raw = parseModelJson(responseText);
  const coerced = raw === null ? null : coerceRaw(raw);
  if (coerced === null) return null;

  return {
    keyClaims: coerced.keyClaims,
    importantFigures: verifyImportantFigures(coerced.figures, article.text),
    economicDrivers: coerced.drivers,
    relevantContext: coerced.relevantContext,
    topics: coerced.topics,
  };
}
