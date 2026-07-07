/* Data hub — single access point for all dashboard data.
   All pages import from here. Never import JSON files directly in pages.
   Country lists are derived from the data — never hardcoded. */

import type {
  DataHub, Country, IndicatorsData, BudgetsData,
  NewsData, PublicationsData, DealsData
} from './types';

import indicatorsRaw from '../../data/almanac-data.json';
import indicatorMetaRaw from '../../data/indicator-meta.json';
import budgetsRaw    from '../../data/budgets.json';
import newsRaw       from '../../data/news.json';
import publicationsRaw from '../../data/publications.json';
import dealsRaw      from '../../data/deals.json';
import { isRelevantNews } from './newsRelevance.mjs';

// Re-export so pages/components have one import surface for news classification.
export { classifyNews, NEWS_GROUPS } from './newsRelevance.mjs';

const indicators  = indicatorsRaw  as IndicatorsData;

// Presentation policy per indicator slug (chartGroup / defaultChart / order).
// Lives in data/indicator-meta.json, NOT on the data records — see SCHEMA.md.
type IndicatorMetaEntry = { chartGroup: string; defaultChart: boolean; order: number };
const indicatorMeta = indicatorMetaRaw as Record<string, IndicatorMetaEntry>;

// Guard: warn at build time if the data and the meta file have drifted apart —
// the exact failure mode (two stores diverging) this hub is meant to prevent.
for (const slug of new Set(indicators.map(s => s.indicator))) {
  if (!(slug in indicatorMeta)) {
    console.warn(`[dataHub] indicator "${slug}" is in the data but missing from indicator-meta.json`);
  }
}
const budgets     = budgetsRaw     as BudgetsData;
// Render-time relevance guard: even if a messy or stale headline slips into the stored
// archive, it can never reach the page. Mirrors the ingest filter in build-feeds.mjs.
const news        = (newsRaw as NewsData).filter(n => isRelevantNews(n.title, n.tags));
const publications = publicationsRaw as PublicationsData;
const deals       = dealsRaw       as DealsData;

// Derive country list from the indicators data — adding a new country's data
// automatically surfaces it in all country selectors without any code change.
const COUNTRY_NAMES: Record<string, string> = {
  GY: 'Guyana',
  TT: 'Trinidad & Tobago',
  BB: 'Barbados',
  JM: 'Jamaica',
  BS: 'Bahamas',
  BZ: 'Belize',
  SR: 'Suriname',
  GD: 'Grenada',
  LC: 'Saint Lucia',
  AG: 'Antigua & Barbuda',
  KN: 'Saint Kitts & Nevis',
  DM: 'Dominica',
  VC: 'Saint Vincent & the Grenadines',
  TC: 'Turks & Caicos',
  KY: 'Cayman Islands',
  VG: 'British Virgin Islands',
};

const COUNTRY_FLAGS: Record<string, string> = {
  GY: '🇬🇾', TT: '🇹🇹', BB: '🇧🇧', JM: '🇯🇲', BS: '🇧🇸',
  BZ: '🇧🇿', SR: '🇸🇷', GD: '🇬🇩', LC: '🇱🇨', AG: '🇦🇬',
  KN: '🇰🇳', DM: '🇩🇲', VC: '🇻🇨', TC: '🇹🇨', KY: '🇰🇾',
  VG: '🇻🇬',
};

export function getCountries(): Country[] {
  const codes = [...new Set(indicators.map(s => s.country))].sort();
  return codes.map(code => ({
    code,
    name: COUNTRY_NAMES[code] ?? code,
    flag: COUNTRY_FLAGS[code],
  }));
}

export interface IndicatorMeta {
  slug: string;
  label: string;        // derived from the data records
  unit: string;         // derived from the data records
  chartGroup: string;   // from indicator-meta.json
  defaultChart: boolean;
  order: number;
}

// All indicators, label/unit derived from the data and merged with the
// presentation policy in indicator-meta.json, sorted by display order.
export function getIndicatorMeta(): IndicatorMeta[] {
  const seen = new Map<string, { label: string; unit: string }>();
  for (const s of indicators) {
    if (!seen.has(s.indicator)) {
      seen.set(s.indicator, { label: s.indicatorLabel, unit: s.unit });
    }
  }
  return [...seen.entries()]
    .map(([slug, meta]) => {
      const m = indicatorMeta[slug] ?? { chartGroup: 'other', defaultChart: false, order: 999 };
      return { slug, ...meta, ...m };
    })
    .sort((a, b) => a.order - b.order);
}

// The subset shown in public chart selectors (defaultChart: true). These are the
// cross-country-comparable indicators; local-currency levels are export-only.
export function getFeaturedIndicators(): IndicatorMeta[] {
  return getIndicatorMeta().filter(m => m.defaultChart);
}

// Returns series for a specific country + indicator combo
export function getSeries(country: string, indicator: string) {
  return indicators.find(s => s.country === country && s.indicator === indicator);
}

// Returns all series for a country (all indicators)
export function getCountryIndicators(country: string) {
  return indicators.filter(s => s.country === country);
}

// Returns the complete indicator series array for the chart
export function getAllSeries() {
  return indicators;
}

// Returns all series for an indicator across all countries
export function getIndicatorAllCountries(indicator: string) {
  return indicators.filter(s => s.indicator === indicator);
}

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

// Full hub export for pages that need multiple domains
export function getDataHub(): DataHub {
  return {
    countries: getCountries(),
    indicators,
    budgets,
    news,
    publications,
    deals,
  };
}
