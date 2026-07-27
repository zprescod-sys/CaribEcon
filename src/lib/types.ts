/* Shared TypeScript types for the CaribEcon data hub.
   All pages import from here — never define data shapes inline in pages. */

// ── Countries ──────────────────────────────────────────────────────────────

export interface Country {
  code: string;        // ISO 3166-1 alpha-2 (GY, TT, etc.)
  name: string;        // Display name
  flag?: string;       // SVG flag asset path, e.g. "/flags/gy.svg"
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

/* Budget figures are held in the country's OWN currency, exactly as printed in
   the official document. No FX conversion is applied: converting would add a
   derived layer with its own provenance burden (and its own error — the former
   USD figures were 4.2% adrift for Guyana) for no analytical gain, since a pie
   is read one country at a time. Every amount must be traceable to a page. */
export interface BudgetCategory {
  name: string;
  slug: string;
  amount: number;         // local-currency MILLIONS, as printed in the source
  sourcePage: string;     // page reference within sourceDocument
  derived?: boolean;      // true = computed residual, not a printed line item
  note?: string;
  projects?: BudgetProject[];
}

export interface BudgetEntry {
  country: string;
  year: number;
  fiscalYear: string;     // "FY2024/25" (TT, JM) or "2024" (GY calendar year)
  currency: string;       // TTD / GYD / JMD
  currencySymbol: string; // "TT$" / "G$" / "J$" — what the source prints
  total: number;          // denominator, local-currency millions
  denominator: string;    // what `total` actually measures
  basis: string;          // cash vs accrual, budget vs actual, what's included
  coverage: string;       // exhaustive partition, or major items + residual
  categories: BudgetCategory[];
  source: string;         // publishing institution
  sourceDocument: string; // document title
  sourceUrl: string;
  sourcePage: string;     // page reference for `total`
  vintage: string;
  note?: string;          // e.g. reconciliation differences from source rounding
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
  categoryOverride?: string;  // approved editorial category from news_unclassified.json
  groupOverride?: string;     // derived from categoryOverride; never entered manually
  // Stored classifier verdict — set once when an item is first ingested (by
  // classifyHeadlinesLLM or, on fallback, the heuristic), then never recomputed.
  // Absent on legacy records that predate this field; both the build-feeds.mjs ingest
  // gate and the dataHub.ts render gate fall back to the live isDisplayableNews /
  // classifyNews heuristic when it's missing.
  category?: string | null;
  group?: string | null;
  decision?: 'publish' | 'review' | 'drop';
  confidence?: 'low' | 'medium' | 'high';
  reason?: string;
  classifier?: 'llm' | 'heuristic';
}

export type NewsData = NewsItem[];

export interface NewsReviewItem extends NewsItem {
  approved: boolean;
  category: string;           // editor fills this before setting approved: true
  suggestedCategory: string;  // pipeline suggestion; may be blank
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  // Triage-owned bookkeeping — written only by scripts/triage-inbox.mjs (via the
  // triage-review-inbox subagent) or a human, never by the classifier. Preserved
  // verbatim across cron re-derivation the same way approved/category already are (see
  // the merge step in build-feeds.mjs's buildNews()) — any new field added here must be
  // added to that preservation list too, or the next feed run silently erases it.
  triaged?: boolean;    // true once a final approve/reject call has been made; stops the
                        // row from resurfacing in `triage-inbox.mjs --list`.
  escalated?: boolean;  // true if triage couldn't confidently decide. Stays paired with
                        // triaged:false so the row keeps surfacing for a human, and is
                        // pinned against eviction the same way approved rows are.
  reviewNote?: string;  // triage's own short reasoning — distinct from `reason` above,
                        // which is machine-owned and overwritten every cron run.
}

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
