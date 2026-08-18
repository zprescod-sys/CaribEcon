/* webEvidence.ts — real external web evidence via Tavily (docs plan §2c).
 *
 * Shaped like news.ts's searchNews/getNewsCoverage pattern (same "deterministic retrieval
 * facade" spirit: a plan step names a tool, this module fetches and maps it into evidence) but
 * necessarily different in one respect news.ts never has to deal with: this calls a REAL
 * external API over the network, so it has real failure modes — a timeout, a rate limit, a
 * non-2xx response, an empty result — that a local JSON read never faces. See the "fails soft"
 * note below for how those are handled.
 *
 * Tavily is not a chat-completions provider, so this does not go through
 * src/lib/ai/config.ts's provider registry (ProviderName only covers nebius/minimax/noinfra —
 * chat-completions-shaped roles). It reads TAVILY_API_KEY directly from process.env, the same
 * way news.ts reads its own JSON files directly rather than going through that registry: each is
 * its own direct integration, not a role.
 *
 * REAL Tavily response shapes, confirmed live on 2026-08-18 (per this file's own build
 * instructions — never assume a third-party API shape from memory) with one throwaway curl
 * script against https://api.tavily.com/search and /extract, then deleted, never committed:
 *
 *   Search (POST /search, body includes `api_key`, `query`, `max_results`, optional
 *   `start_date`/`end_date` in YYYY-MM-DD):
 *     { results: [ { title, url, content, score, raw_content, id,
 *                    published_date? } ], response_time, request_id, ... }
 *   - `content` is Tavily's search-result snippet (NOT full body text — that's what `extract` is
 *     for). `raw_content` is null unless `include_raw_content` is requested, which searchWeb
 *     does not ask for; extraction is extractWeb's job, on plan-authorized URLs only.
 *   - `published_date` is present (RFC 2822 string, e.g. "Mon, 09 Mar 2026 12:00:00 GMT") when
 *     `topic: "news"` is set; confirmed ABSENT on a default `topic: "general"` search, even with
 *     start_date/end_date set. searchWeb does not force topic:news (a plan-authorized query can
 *     be about anything, not just news), so publishedDate is frequently null — exactly what
 *     WebEvidence.publishedDate's own doc comment ("only when Tavily supplies one") anticipates.
 *
 *   Extract (POST /extract, body { api_key, urls: string[] }):
 *     { results: [ { url, title, raw_content, images } ], failed_results: [ { url, error } ],
 *       response_time, request_id }
 *   - A 200 response can still carry a URL in `failed_results` instead of `results` (confirmed
 *     live against an unresolvable host) — HTTP status alone does not mean every URL succeeded,
 *     so extractWeb reads `results` only and silently omits anything not there.
 *
 * Fails soft, not closed: a missing API key, a network error, a non-2xx response, an unparseable
 * body, or an empty result set never throws — both functions return an empty array/Map and let
 * the caller (the executor) record a RetrievalMiss and carry on. Same precedent as
 * newsArticleFetch.ts's header comment and verify.ts's: an external-reach step degrades the
 * request, it never takes the whole thing down.
 */

import { createHash } from 'node:crypto';
import { MAX_EXTRACT_CHARS, MAX_EXTRACT_TOTAL } from './ai/config.js';
import type { WebEvidence } from './ai/contracts.js';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const FETCH_TIMEOUT_MS = 10_000;

// Tavily's own default page size. MAX_TAVILY_SEARCHES (config.ts) bounds how many search CALLS
// the executor may issue per request — a separate budget from how many results one call returns.
const SEARCH_MAX_RESULTS = 5;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return ''; // Malformed URL from upstream — should not happen, but never throw over it.
  }
}

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

/* One Tavily Search call, mapped to WebEvidence. `extract` is always null here — Search alone
 * never returns body text; only extractWeb (below), run on a subset of these URLs by a later
 * plan-authorized extract_web step, can populate it.
 *
 * `authorizedBy` is deliberately left as '' — an empty string, not omitted (WebEvidence.
 * authorizedBy is a required `string`, so every returned object is still a structurally valid
 * WebEvidence). This function has no notion of "which plan step is running" — that is the
 * executor's concept, not this facade's, exactly the same separation news.ts keeps between
 * "what does the hub contain" and "why was this search run." Keeping it out of this signature
 * also keeps searchWeb trivially testable in isolation (a test calls it exactly like a caller
 * with a real question would, with no step-id bookkeeping to fake). The executor — the only
 * caller that actually knows the authorizing step's id — MUST overwrite `authorizedBy` on every
 * returned WebEvidence with that step's real id before the result is stored in an
 * EvidencePackage; an unoverwritten '' would fail plan-authorization checks downstream by
 * construction, which is the safe failure direction. */
export async function searchWeb(
  query: string,
  dateFrom: string | null,
  dateTo: string | null,
): Promise<WebEvidence[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];

  const requestBody: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: SEARCH_MAX_RESULTS,
  };
  if (dateFrom) requestBody.start_date = dateFrom;
  if (dateTo) requestBody.end_date = dateTo;

  let response: Response;
  try {
    response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return []; // network error, DNS failure, or timeout
  }
  if (!response.ok) return []; // 401 / 429 / 5xx etc.

  let parsed: TavilySearchResponse;
  try {
    parsed = await response.json();
  } catch {
    return [];
  }

  const retrievedAt = new Date().toISOString();

  return (parsed.results ?? [])
    .filter((r): r is TavilySearchResult & { url: string; title: string } => Boolean(r.url && r.title))
    .map(r => ({
      id: `W:${sha256Hex(r.url)}`,
      title: r.title,
      url: r.url,
      domain: domainOf(r.url),
      publishedDate: r.published_date ?? null,
      retrievedAt,
      snippet: r.content ?? '',
      extract: null,
      authorizedBy: '',
    }));
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string | null;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  // failed_results exists on the real response but is intentionally unread here: a failed URL is
  // simply absent from the returned Map, which is all a caller needs to treat it as a miss.
}

/* One Tavily Extract call over `urls` (already capped by the caller against
 * MAX_TAVILY_EXTRACTS — this function trusts that and does not re-check array length). Defensive
 * caps are still enforced here, independently of whatever the caller already did, because
 * extract.text ends up quoted in a published answer (quote_check / web_figure_reconciliation,
 * §2.6 checks 8 & 11) and an over-long extract is a correctness/cost problem this function can
 * prevent cheaply: MAX_EXTRACT_CHARS per URL, MAX_EXTRACT_TOTAL summed across every URL in this
 * call, both from ai/config.ts. Truncates rather than erroring — a shorter-than-requested extract
 * is still usable evidence; refusing it outright would not be. */
export async function extractWeb(urls: string[]): Promise<Map<string, { text: string; chars: number }>> {
  const out = new Map<string, { text: string; chars: number }>();
  if (!urls.length) return out;

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return out;

  let response: Response;
  try {
    response = await fetch(TAVILY_EXTRACT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, urls }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return out;
  }
  if (!response.ok) return out;

  let parsed: TavilyExtractResponse;
  try {
    parsed = await response.json();
  } catch {
    return out;
  }

  let totalChars = 0;
  for (const r of parsed.results ?? []) {
    if (!r.url || !r.raw_content) continue; // no body text, or a URL Tavily otherwise skipped
    if (totalChars >= MAX_EXTRACT_TOTAL) break; // total budget already spent — drop the rest

    const cap = Math.min(MAX_EXTRACT_CHARS, MAX_EXTRACT_TOTAL - totalChars);
    const text = r.raw_content.slice(0, cap);
    if (!text.length) continue;

    out.set(r.url, { text, chars: text.length });
    totalChars += text.length;
  }

  return out;
}
