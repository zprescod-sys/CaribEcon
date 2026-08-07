/* Data hub — single access point for all dashboard data.
   All pages import from here. Never import JSON files directly in pages.
   Country lists are derived from the data — never hardcoded. */

import type {
  BudgetsData,
  NewsData, NewsItem, NewsReviewItem, PublicationsData, DealsData
} from './types';

import budgetsRaw    from '../../data/budgets.json';
import newsRaw       from '../../data/news.json';
import newsReviewRaw from '../../data/news_unclassified.json';
import publicationsRaw from '../../data/publications.json';
import dealsRaw      from '../../data/deals.json';
import { isDisplayableNews, NEWS_CATEGORY_GROUPS } from './newsRelevance.mjs';

// Re-export so pages/components have one import surface for news classification.
export { classifyNews, NEWS_GROUPS } from './newsRelevance.mjs';

/* Indicator series, country list, and indicator presentation policy live in
   ./indicators.ts — split out so consumers needing only indicator data (notably
   api/indicator.ts) can skip the editorial JSON imported below. Re-exported here
   so pages keep one import surface and nothing about their imports changes. */
export {
  getCountries, getIndicatorMeta, getFeaturedIndicators,
  getSeries, getAllSeries, getIndicatorAllCountries,
} from './indicators';
export type { IndicatorMeta } from './indicators';

const budgets     = budgetsRaw     as BudgetsData;

// Base archive stays machine-owned and precision-filtered. Approved editorial inbox
// rows bypass that classifier intentionally, carry an explicit category override, and
// replace a same-id archive row when present. news.json itself is never hand-edited.
const approvedNews = (newsReviewRaw as NewsReviewItem[])
  .filter(row => row.approved === true)
  .map(row => {
    const group = NEWS_CATEGORY_GROUPS[row.category];
    if (!group) {
      throw new Error(`[dataHub] approved news review row "${row.id}" has invalid category "${row.category}"`);
    }
    return {
      id: row.id,
      title: row.title,
      source: row.source,
      date: row.date,
      country: row.country,
      url: row.url,
      ...(row.tags?.length ? { tags: row.tags } : {}),
      categoryOverride: row.category,
      groupOverride: group,
    };
  });

// A record classified by the LLM (or the heuristic fallback, at ingest) carries its own
// stored `decision` — trust it rather than re-deriving from the heuristic. Only legacy
// records with no stored decision (predating this field) fall through to the live
// heuristic, exactly as every record did before this field existed.
function isPublishable(item: NewsItem): boolean {
  if (item.decision) return item.decision === 'publish';
  return isDisplayableNews(item.title, item.tags);
}

const newsById = new Map(
  (newsRaw as NewsData)
    .filter(isPublishable)
    .map(item => [item.id, item]),
);
for (const item of approvedNews) newsById.set(item.id, item);
const news = [...newsById.values()]
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
const publications = publicationsRaw as PublicationsData;
const deals       = dealsRaw       as DealsData;

// Returns budget entry for country + year
export function getBudget(country: string, year: number) {
  return budgets.find(b => b.country === country && b.year === year) ?? null;
}

// Returns all budget years for a country
export function getBudgetYears(country: string): number[] {
  return budgets
    .filter(b => b.country === country)
    .map(b => b.year)
    .sort((a, b) => b - a);
}

// Returns news, optionally filtered by country code. Pass undefined for all.
export function getNews(country?: string): NewsData {
  if (!country) return news;
  return news.filter(item => {
    if (Array.isArray(item.country)) return item.country.includes(country);
    return item.country === country || item.country === 'ALL';
  });
}

// Returns publications, optionally filtered by country code
export function getPublications(country?: string): PublicationsData {
  if (!country) return publications;
  return publications.filter(p => {
    if (Array.isArray(p.country)) return p.country.includes(country);
    return p.country === country || p.country === 'REGION';
  });
}

// Returns deals, optionally filtered by country code
export function getDeals(country?: string): DealsData {
  if (!country) return deals;
  return deals.filter(d => {
    if (Array.isArray(d.country)) return d.country.includes(country);
    return d.country === country;
  });
}
