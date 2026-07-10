/* Shared TypeScript types for the CaribEcon data hub.
   All pages import from here — never define data shapes inline in pages. */

// ── Countries ──────────────────────────────────────────────────────────────

export interface Country {
  code: string;        // ISO 3166-1 alpha-2 (GY, TT, etc.)
  name: string;        // Display name
  flag?: string;       // Emoji flag (optional)
}

// ── Indicators ─────────────────────────────────────────────────────────────

export type DataPointType = 'actual' | 'estimate' | 'projection' | 'derived';

// Sourcing tier and confidence (see data/SCHEMA.md)
export type SourceTier = 'primary' | 'comparable';
export type Confidence = 'high' | 'medium' | 'flagged';

export interface IndicatorPoint {
  year: number;
  value: number | null;     // null = unavailable; never guess
  type: DataPointType;
  vintage: string;          // "2024-10" = IMF WEO October 2024 release
  sourceNote?: string;      // overrides series source for this point
}

export interface IndicatorSeries {
  country: string;          // matches Country.code
  indicator: string;        // slug: gdp_growth, inflation, etc.
  indicatorLabel: string;
  unit: string;             // "%" | "USD bn" | "USD mn" | etc.
  unitNote?: string;        // e.g. "constant 2017 prices"
  source: string;           // e.g. "IMF World Economic Outlook (Oct 2024)"
  sourceOrg: string;        // e.g. "IMF"
  sourceTier: SourceTier;   // primary (national) | comparable (IMF/WB/UN)
  sourceUrl: string;
  sourceRef?: string;       // table/appendix/section cited — never a page number
  confidence: Confidence;   // high | medium | flagged
  seriesNote?: string;      // record-level note (e.g. source-divergence caveat)
  series: IndicatorPoint[];
}

// Convenience: all series for all countries keyed by indicator slug
export type IndicatorsData = IndicatorSeries[];

// ── Budgets ────────────────────────────────────────────────────────────────

export interface BudgetProject {
  name: string;
  description?: string;
}

export interface BudgetCategory {
  name: string;
  slug: string;
  value: number;        // USD millions
  pct: number;          // percentage of total (0–100)
  projects: BudgetProject[];
}

export interface BudgetEntry {
  country: string;
  year: number;
  fiscalYear?: string;  // e.g. "2024/25" for TT
  totalUSD: number;     // total budget in USD millions
  currency: string;     // original currency (GYD, TTD)
  originalTotal: number;
  exchangeRate: number; // USD per 1 local currency unit used for conversion
  categories: BudgetCategory[];
  source: string;
  sourceUrl: string;
  vintage: string;
}

export type BudgetsData = BudgetEntry[];

// ── News ───────────────────────────────────────────────────────────────────

export interface NewsItem {
  id: string;           // slug / stable ID
  title: string;
  source: string;       // publication name
  date: string;         // ISO 8601
  country: string | string[];  // "ALL" for pan-Caribbean; or country code(s)
  url: string;
  tags?: string[];
}

export type NewsData = NewsItem[];

// ── Publications ───────────────────────────────────────────────────────────

export type PublicationType =
  | 'Article IV'
  | 'World Economic Outlook'
  | 'Staff Report'
  | 'Country Report'
  | 'Working Paper'
  | 'Development Report'
  | 'Regional Economic Outlook'
  | 'Other';

export interface Publication {
  id: string;
  title: string;
  body: string;         // issuing organization (IMF, World Bank, etc.)
  type: PublicationType;
  date: string;         // ISO 8601 (publication date)
  country: string | string[];  // country code(s) covered; "REGION" for regional
  summary: string;      // 1–2 sentence editorial summary (your words)
  url: string;
}

export type PublicationsData = Publication[];

// ── Deals & Investment ─────────────────────────────────────────────────────

export type DealType = 'M&A' | 'FDI' | 'Bond' | 'IPO' | 'JV' | 'Concession' | 'Other';

export interface Deal {
  id: string;
  headline: string;
  parties?: string;     // "Buyer / Seller" or key actors
  value?: string;       // e.g. "$1.2bn" — string to allow "undisclosed"
  date: string;         // ISO 8601
  country: string | string[];
  type: DealType;
  url: string;
  source: string;
}

export type DealsData = Deal[];

// ── Data hub export ────────────────────────────────────────────────────────

export interface DataHub {
  countries: Country[];
  indicators: IndicatorsData;
  budgets: BudgetsData;
  news: NewsData;
  publications: PublicationsData;
  deals: DealsData;
}
