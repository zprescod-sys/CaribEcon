/* News Hub reader — the editorial half of what Ask CaribEcon can retrieve.

   Split out for the same reason indicators.ts was: api/ask.ts needs headlines but must not
   import dataHub.ts, which is not nodenext-clean (extensionless specifiers, bare JSON imports)
   and so resolves under Astro's bundler but throws ERR_MODULE_NOT_FOUND in a deployed Vercel
   function. This module uses explicit .js specifiers and JSON import attributes throughout so it
   satisfies both pipelines. See the header of indicators.ts for the full history.

   Not to be confused with newsSearch.ts, which is the News *page's* search/pagination logic and
   ships to the browser. Its normalise/match helpers look reusable here but are not: that file
   uses extensionless specifiers, so pulling it into this import graph would reintroduce exactly
   the production failure described above.

   What this module deliberately does NOT do: return, summarise, or infer article text. The hub
   stores headline, source, date, country, link and classifier metadata — never a body. Anything
   downstream that implies the article was read is a fabrication, so nothing here hands out a
   field that could be mistaken for one. */

import type { NewsItem, NewsReviewItem } from './types.js';

import newsRaw       from '../../data/news.json' with { type: 'json' };
import newsReviewRaw from '../../data/news_unclassified.json' with { type: 'json' };

/* Only what Ask CaribEcon may cite. `country` is a plain string because every stored record
   holds one — the wider `string | string[]` in types.ts covers the shape news.json permits,
   not the shape it currently contains. Revisit if a multi-country record ever lands. */
export interface NewsEvidence {
  id: string;
  title: string;
  source: string;
  date: string;      // ISO 8601, YYYY-MM-DD
  country: string;   // 2-letter code, or "ALL" for pan-Caribbean
  url: string;
  category?: string;
  tags?: string[];
}

export interface NewsSearchInput {
  countries?: string[];
  keywords?: string[];
  dateFrom?: string | null;  // inclusive, YYYY-MM-DD
  dateTo?: string | null;    // inclusive, YYYY-MM-DD
  limit?: number;
}

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 12;

/* The published set, built to be a strict SUBSET of what the website shows — never a superset.
   Two admitted kinds of record:

   1. news.json rows the LLM classifier explicitly decided to publish. dataHub.ts is more
      permissive here: for the ~850 legacy rows that predate the `decision` field it falls back
      to the older regex heuristic. Ask CaribEcon does not, because a grounded answer should
      lean on the vetted verdict rather than a keyword guess. Cost of the stricter gate is real
      (1,135 of 1,987 rows) and accepted.
   2. news_unclassified.json rows a human approved. A human call outranks a classifier one, and
      dataHub.ts already treats these as publishable. Their category is trusted as-is: dataHub.ts
      hard-fails the build on an invalid one, so a bad value can never reach a deploy. */
function toEvidence(item: NewsItem, category?: string): NewsEvidence {
  const resolvedCategory = category ?? item.category ?? undefined;
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    date: item.date,
    country: item.country as string,
    url: item.url,
    ...(resolvedCategory ? { category: resolvedCategory } : {}),
    ...(item.tags?.length ? { tags: item.tags } : {}),
  };
}

const published: NewsEvidence[] = (() => {
  const byId = new Map<string, NewsEvidence>();
  for (const item of newsRaw as NewsItem[]) {
    if (item.decision === 'publish') byId.set(item.id, toEvidence(item));
  }
  for (const row of newsReviewRaw as NewsReviewItem[]) {
    if (row.approved === true) byId.set(row.id, toEvidence(row, row.category));
  }
  // Newest first, id as the tiebreaker so equal-dated records never reorder between calls.
  return [...byId.values()].sort((a, b) =>
    a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1,
  );
})();

/* The archive's real extent. Callers need this to say "the News Hub covers X to Y" instead of
   returning nothing and letting a model imply the events did not happen. Coverage is much
   narrower than the indicator hub's — a question about 2024 has no news evidence at all, and
   that gap has to be stated, not papered over. */
export function getNewsCoverage(): { earliest: string; latest: string; count: number } {
  return {
    earliest: published[published.length - 1]?.date ?? '',
    latest: published[0]?.date ?? '',
    count: published.length,
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Title, source and category are prose, so they match on word boundaries — "oil" must not hit
   "spoiled". Tags are short curated slugs, so they match on substring: the tag "exxonmobil"
   should answer a search for "Exxon", which a boundary match would miss. */
function scoreKeyword(item: NewsEvidence, keyword: string): number {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return 0;

  const word = new RegExp(`\\b${escapeRegExp(needle)}`, 'i');
  let score = 0;

  if (word.test(item.title)) score += 3;
  if (item.tags?.some(t => t.toLowerCase().includes(needle))) score += 2;
  if (item.category && word.test(item.category)) score += 1;
  if (word.test(item.source)) score += 1;

  return score;
}

function matchesCountry(item: NewsEvidence, countries: string[]): boolean {
  if (!countries.length) return true;
  // "ALL" is pan-Caribbean and relevant to every country query — same rule dataHub.getNews uses.
  return item.country === 'ALL' || countries.includes(item.country);
}

/* Deterministic retrieval: same inputs always return the same records in the same order, so a
   citation can be traced back to a rule rather than to a model's choice. Ranking is keyword
   score first, then recency within the requested window, then id. */
export function searchNews(input: NewsSearchInput = {}): NewsEvidence[] {
  const countries = (input.countries ?? []).map(c => c.toUpperCase());
  const keywords = (input.keywords ?? []).map(k => k.trim()).filter(Boolean);
  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const from = input.dateFrom || null;
  const to = input.dateTo || null;

  const inWindow = published.filter(item => {
    if (from && item.date < from) return false;
    if (to && item.date > to) return false;
    return matchesCountry(item, countries);
  });

  // No keywords means the question is about a country/period rather than a subject; the window
  // filter has already done the selecting, so return the most recent of it.
  if (!keywords.length) return inWindow.slice(0, limit);

  const scored = inWindow
    .map(item => ({ item, score: keywords.reduce((sum, k) => sum + scoreKeyword(item, k), 0) }))
    .filter(entry => entry.score > 0);

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.item.date !== b.item.date) return a.item.date < b.item.date ? 1 : -1;
    return a.item.id.localeCompare(b.item.id);
  });

  return scored.slice(0, limit).map(entry => entry.item);
}
