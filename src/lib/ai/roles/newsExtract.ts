/* summarizeArticle() — the 'newsExtract' role (docs/ARCHITECTURE.md's news-digest side path,
 * plan §2h). Turns already-fetched article text into a short, factual digest for the
 * synthesizer's own reading convenience.
 *
 * Structurally this mirrors interpret.ts's pattern exactly: resolveRoleFully('newsExtract'), one
 * callModel call at temperature 0, no tool loop. The ONE deliberate difference is the contract
 * below — read it before calling this function from anywhere new.
 *
 * ── Fail-soft contract (the one place in this pipeline that intentionally swallows failures) ──
 * Every other role (interpret/plan/synthesis/verify) throws a *NotConfiguredError when
 * unconfigured, which fails the whole request — that is correct for them because each is a hard
 * pipeline dependency. summarizeArticle() is NOT: it is a genuinely optional enrichment step (2h
 * in the plan), not a new hard dependency for /api/ask. So this function NEVER THROWS. It
 * returns null, not an exception, in every failure case:
 *   - the role is unconfigured (resolveRoleFully('newsExtract') returns null)
 *   - the model call itself fails (network error, timeout, non-2xx from the provider —
 *     ProviderCallError from callModel)
 *   - the model responds but with empty/whitespace-only text
 * The CALLER (the executor) is expected to treat null as "no digest available, proceed without
 * one" — it still has the raw fetched text (from fetchArticleText) to put into evidence
 * un-summarized. Do not add a new caller that treats a null return as an error; that would
 * silently turn an optional enrichment into a hard dependency this function was explicitly
 * designed not to be.
 *
 * ── Why the raw text, never this summary, is what grounding checks against ──
 * quote_check and web_figure_reconciliation (grounding.ts) verify synthesis output against
 * WebEvidence.extract.text because that text is the thing a deterministic fetch
 * (newsArticleFetch.ts) actually pulled from the real page — it is checkable *because* code, not
 * a model, put it there. This function's output (WebEvidence.extract.summary) is a MODEL'S
 * reading of that text: a second-hand paraphrase, not independently verifiable against the
 * source. It exists purely as a synthesis-time reading aid — a cheap, pre-digested "what this
 * article said and why it's relevant" — and must never become a citable source of truth on its
 * own, or a summarization slip could quietly widen what counts as grounded.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';

const SYSTEM_PROMPT = [
  "You compress a real news article into a short, factual summary (2-4 sentences) for a",
  "research analyst's internal use. State only what the article itself says — do not add",
  'outside knowledge, speculation, or opinion. If the article text is truncated or unclear,',
  'summarize only what is legible.',
].join('\n');

export interface ArticleForSummary {
  title: string;
  url: string;
  text: string;
  publishedDate: string | null;
}

function buildUserContent(article: ArticleForSummary): string {
  return [
    `Title: ${article.title}`,
    `URL: ${article.url}`,
    `Published: ${article.publishedDate ?? 'unknown'}`,
    '',
    'Article text:',
    article.text,
  ].join('\n');
}

/* Returns the digest, or null if enrichment could not happen for any reason — see the fail-soft
   contract in the file header. Never throws. */
export async function summarizeArticle(article: ArticleForSummary): Promise<string | null> {
  const resolved = resolveRoleFully('newsExtract');
  if (!resolved) return null;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserContent(article) },
  ];

  let responseText: string;
  try {
    const response = await callModel(resolved.connection, resolved.model, messages, {
      temperature: 0,
      // A compression task over already-fetched text, not open-ended generation — a small cap
      // keeps this cheap and fast, matched by a short timeout so it never becomes the slowest
      // step in a concurrent digest batch (plan §2h: independent budget, MAX_NEWS_DIGESTS).
      maxTokens: 500,
      timeoutMs: 15_000,
    });
    responseText = response.text;
  } catch {
    // Network error, timeout, or provider error (ProviderCallError) — swallow, not propagate.
    return null;
  }

  const trimmed = responseText.trim();
  return trimmed.length > 0 ? trimmed : null;
}
