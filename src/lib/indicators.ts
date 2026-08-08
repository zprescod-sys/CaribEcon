/* Indicator series + country list — the subset of the hub that depends ONLY on
   almanac-data.json and indicator-meta.json.

   Split out of dataHub.ts so a consumer that needs nothing but indicator data can
   import it without pulling in the editorial domains. dataHub.ts imports every
   domain file at module scope (news.json alone is >1MB and grows with every daily
   cron run), so a serverless function answering a single indicator lookup would
   otherwise parse ~1.9MB of JSON and run the whole news merge on every cold start.
   See api/indicator.ts, the one consumer that needs that leanness.

   Pages must keep importing from dataHub.ts, which re-exports all of this — one
   import surface, exactly as before. Nothing here is page-facing on its own. */

/* Explicit .js specifier and JSON import attributes are required, not stylistic: this
   module is in api/indicator.ts's import graph, and Vercel type-checks and runs functions
   under moduleResolution/module "nodenext" (the repo is "type": "module"). Extensionless
   specifiers and bare JSON imports are errors there — they compiled locally under Astro's
   bundler resolution but failed at runtime in production with ERR_MODULE_NOT_FOUND.
   Vite/Astro accept this stricter form too, so it satisfies both pipelines. */
import type { Country, IndicatorsData } from './types.js';

import indicatorsRaw from '../../data/almanac-data.json' with { type: 'json' };
import indicatorMetaRaw from '../../data/indicator-meta.json' with { type: 'json' };

const indicators = indicatorsRaw as IndicatorsData;

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
  HT: 'Haiti',
  AW: 'Aruba',
  CW: 'Curaçao',
};

// Flags are local SVG assets (public/flags/<code>.svg), not emoji — emoji flags
// don't render on Windows (Segoe UI Emoji omits the glyphs), so they're
// unreliable cross-browser. SVGs render identically everywhere.
function flagSrc(code: string): string {
  return `/flags/${code.toLowerCase()}.svg`;
}

export function getCountries(): Country[] {
  const codes = [...new Set(indicators.map(s => s.country))].sort();
  return codes.map(code => ({
    code,
    name: COUNTRY_NAMES[code] ?? code,
    flag: flagSrc(code),
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

// Returns the complete indicator series array for the chart
export function getAllSeries() {
  return indicators;
}

// Returns all series for an indicator across all countries
export function getIndicatorAllCountries(indicator: string) {
  return indicators.filter(s => s.indicator === indicator);
}
