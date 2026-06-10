/* Data hub — single access point for all dashboard data.
   All pages import from here. Never import JSON files directly in pages.
   Country lists are derived from the data — never hardcoded. */

import type {
  DataHub, Country, IndicatorsData, BudgetsData,
  NewsData, PublicationsData, DealsData
} from './types';

import indicatorsRaw from '../../data/indicators.json';
import budgetsRaw    from '../../data/budgets.json';
import newsRaw       from '../../data/news.json';
import publicationsRaw from '../../data/publications.json';
import dealsRaw      from '../../data/deals.json';

const indicators  = indicatorsRaw  as IndicatorsData;
const budgets     = budgetsRaw     as BudgetsData;
const news        = newsRaw        as NewsData;
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
  GD: 'Grenada',
  LC: 'Saint Lucia',
  VC: 'Saint Vincent',
  AG: 'Antigua & Barbuda',
  DM: 'Dominica',
  KN: 'Saint Kitts & Nevis',
  BZ: 'Belize',
  SR: 'Suriname',
  HT: 'Haiti',
};

const COUNTRY_FLAGS: Record<string, string> = {
  GY: '🇬🇾', TT: '🇹🇹', BB: '🇧🇧', JM: '🇯🇲', BS: '🇧🇸',
  GD: '🇬🇩', LC: '🇱🇨', VC: '🇻🇨', AG: '🇦🇬', DM: '🇩🇲',
  KN: '🇰🇳', BZ: '🇧🇿', SR: '🇸🇷', HT: '🇭🇹',
};

export function getCountries(): Country[] {
  const codes = [...new Set(indicators.map(s => s.country))].sort();
  return codes.map(code => ({
    code,
    name: COUNTRY_NAMES[code] ?? code,
    flag: COUNTRY_FLAGS[code],
  }));
}

// Returns all available indicator slugs with labels
export function getIndicatorMeta(): { slug: string; label: string; unit: string }[] {
  const seen = new Map<string, { label: string; unit: string }>();
  for (const s of indicators) {
    if (!seen.has(s.indicator)) {
      seen.set(s.indicator, { label: s.indicatorLabel, unit: s.unit });
    }
  }
  return [...seen.entries()].map(([slug, meta]) => ({ slug, ...meta }));
}

// Returns series for a specific country + indicator combo
export function getSeries(country: string, indicator: string) {
  return indicators.find(s => s.country === country && s.indicator === indicator);
}

// Returns all series for a country (all indicators)
export function getCountryIndicators(country: string) {
  return indicators.filter(s => s.country === country);
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
