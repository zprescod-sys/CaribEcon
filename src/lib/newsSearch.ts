/* Shared news search/pagination logic — used both at build time (news.astro,
   news-index.json.ts) and in the browser (NewsFeed.astro's client script), so the
   two never drift out of sync. Importing `classifyNews` here is safe to ship to the
   browser: newsRelevance.mjs has zero imports of its own (just regex/logic), unlike
   dataHub.ts which pulls in every JSON data file and must never be imported client-side. */
import { classifyNews } from './newsRelevance.mjs';
import type { NewsItem } from './types';

// Matches CLAUDE.md's documented "25/page" for the News page.
export const NEWS_PAGE_SIZE = 25;

// Diacritic-fold + "T&T"/"T and T" -> "tt trinidad tobago" + punctuation collapse.
// Same behavior as the pre-refactor inline version (verified with real test cases):
// same NFD-then-strip approach, using the Unicode Diacritic property escape instead
// of a hardcoded combining-mark code point range. Normalizes both the stored search
// text and the live query, so matching behavior never changes.
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\bt\s*(?:&|and)\s*t\b/g, 'tt trinidad tobago')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function splitTerms(normalizedQuery: string): string[] {
  return normalizedQuery ? normalizedQuery.split(/\s+/).filter(term => term !== 'and') : [];
}

export function matchesTerms(normalizedHaystack: string, terms: string[]): boolean {
  return terms.every(term => normalizedHaystack.includes(term));
}

// Category/group priority: a human-approved override wins; then the stored
// classifier verdict (LLM or heuristic fallback, written once at ingest); only a
// legacy record with neither falls through to a fresh classifyNews() re-derivation.
export function resolveCategoryGroup(
  item: Pick<NewsItem, 'categoryOverride' | 'category' | 'groupOverride' | 'group' | 'title' | 'tags'>,
): { category: string | null; group: string | null } {
  let category = item.categoryOverride ?? item.category;
  let group = item.groupOverride ?? item.group;
  if (category == null || group == null) {
    const classified = classifyNews(item.title, item.tags);
    category ??= classified.category;
    group ??= classified.group;
  }
  return { category: category ?? null, group: group ?? null };
}

export function buildSearchText(params: {
  title: string;
  source: string;
  date: string;
  country: string;
  category: string | null;
  countryLabels: string[];
  tags?: string[];
}): string {
  return [
    params.title,
    params.source,
    params.date,
    params.country,
    params.category ?? '',
    ...params.countryLabels,
    ...(params.tags ?? []),
  ].join(' ');
}

// The lean shape shipped in news-index.json — everything the client needs to
// render a card and filter/search it, nothing else (no article bodies, no raw tags).
export interface NewsIndexItem {
  id: string;
  title: string;
  source: string;
  date: string;
  country: string | string[];
  url: string;
  category: string | null;
  group: string | null;
  searchText: string; // pre-normalized, ready for matchesTerms()
}
