/* Deterministic Excel output planning — ChartSpec and WorkbookPlan (plan §5, §6 step 6, §8).

   The division of labour this file exists to enforce: a model may propose *that* a chart is
   wanted, but every coordinate, heading, number format, series colour and cell value is decided
   here, in code, from evidence that was already retrieved. Plan §5: "Models never emit raw
   Office.js, workbook coordinates, formulas, source URLs, or citation text."

   Everything here is pure. No Office.js, no I/O, no clock, no randomness — the same evidence in
   always produces the same plan out, which is what makes the renderer testable at all (the
   Office.js layer that executes this plan can only be smoke-tested by hand, per §10).

   Nodenext-safe (explicit .js specifiers) because api/deepdive.ts imports this and Vercel
   type-checks and runs functions under moduleResolution "nodenext" — see the header of
   indicators.ts for the production failure that convention prevents. */

import type { DataEvidence, DataPoint, RetrievalMiss } from './askTools.js';
import type { CalculationResult } from './calculations.js';
import type { SingleCountryIntent } from './excelIntent.js';

/* Excel's own sheet-name rules, not ours: 31 characters, and these characters are rejected
   outright by the host. Breaking either throws at worksheets.add() time, which would surface to
   the analyst as a failed insert rather than a bad name. */
const SHEET_NAME_MAX = 31;
const SHEET_NAME_ILLEGAL = /[[\]*?/\\:]/g;

/* Brand chart palette, mirrored from src/styles/tokens.css (--series-1..8) so a chart written
   into a workbook matches the same series colours the site uses. Duplicated deliberately: this
   module is imported by a serverless function and must not pull in a CSS file to read a token. */
export const SERIES_COLORS = [
  '#0E5E4E', '#BC8A2E', '#1E3A5F', '#A8542E',
  '#6A4A6E', '#5A6B6E', '#5C6B3A', '#9A5B2E',
] as const;

/* A series that is already a rate takes percentage-POINT change; everything else takes relative
   percentage change. See the pp_change header in calculations.ts for why this matters. */
export function calculationForUnit(unit: string): 'pp_change' | 'yoy_change' {
  return unit.trim() === '%' ? 'pp_change' : 'yoy_change';
}

/* Stable evidence ID (plan §5: "every retrieved series and news item has a stable evidence ID").
   Derived from the record's own identity rather than assigned by position, so the same series
   carries the same ID across requests and a figure in the report can be traced to its lineage
   row on the Evidence sheet. */
export function evidenceId(country: string, indicator: string): string {
  return `${country}:${indicator}`;
}

// ── Contracts ──────────────────────────────────────────────────────────────────────────────

/* Plan §5: "A validated ChartSpec defines chart type, indicator, countries, year range, and
   title." One indicator, many countries — deliberately: Deep Dive passes one country and three
   indicators as three separate specs, while Comparison (Phase 3a) will pass many countries and
   one indicator into this same shape. Mixing indicators onto one chart is never correct here,
   because units differ per indicator and a shared axis would invite exactly the local-currency
   comparison askTools.ts already refuses to support. */
export interface ChartSpec {
  type: 'line';
  indicator: string;
  indicatorLabel: string;
  countries: string[];
  yearFrom: number;
  yearTo: number;
  unit: string;
  title: string;
  evidenceIds: string[];
}

export interface TableSection {
  kind: 'table';
  startRow: number;
  rowCount: number;
  columnCount: number;
  /* How many of `rows` are data rows. Published rather than left for the renderer to derive
     from the offsets below, so number formats are applied to exactly the right band without the
     task pane re-doing layout arithmetic this module already did. */
  dataRowCount: number;
  evidenceIds: string[];
  indicator: string;
  label: string;
  unit: string;
  /* The header row and body, already assembled in write order. `null` is a real hub gap and is
     written as an empty cell — never zero, never omitted, so a gap year still occupies a row. */
  header: string[];
  rows: (string | number | null)[][];
  /* Row offsets, relative to startRow, that the renderer styles specially. Kept here rather than
     recomputed in the task pane so the layout has exactly one source of truth. */
  titleRowOffset: number;
  headerRowOffset: number;
  firstDataRowOffset: number;
  summaryRowOffsets: number[];
}

export interface ListSection {
  kind: 'sources' | 'caveats';
  startRow: number;
  rowCount: number;
  columnCount: number;
  heading: string;
  rows: string[][];
}

export type WorkbookSection = TableSection | ListSection;

export interface ChartPlacement {
  spec: ChartSpec;
  /* Anchored beside its own table rather than below it, so the numbers stay readable next to the
     picture. Both are 0-based sheet offsets; the renderer converts to a range. */
  row: number;
  column: number;
  widthColumns: number;
  heightRows: number;
  /* The data range the chart plots, as offsets into the owning table section. */
  sourceStartRow: number;
  sourceRowCount: number;
  sourceValueColumn: number;
}

/* One row per retrieved data point, carrying full lineage (plan §6 step 6: "a second Evidence
   sheet with full lineage"). `calculation`/`inputYears` record which registry function consumed
   the point and which years fed it, so every computed figure in the report can be reconciled
   back to its inputs without re-running anything. */
export interface EvidenceRow {
  evidenceId: string;
  country: string;
  indicator: string;
  label: string;
  year: number;
  value: number | null;
  type: string;
  unit: string;
  vintage: string;
  source: string;
  sourceOrg: string;
  sourceTier: string;
  sourceUrl: string;
  confidence: string;
  note: string;
}

/* Column order and headings for the Evidence sheet, as [key, heading] pairs. Single source of
   truth: the plan's evidenceHeader is derived from this, and the renderer reads each cell by the
   same key — so a column added here appears in both, and neither can silently drift from the
   EvidenceRow shape. */
export const EVIDENCE_COLUMNS: readonly (readonly [keyof EvidenceRow, string])[] = [
  ['evidenceId', 'Evidence ID'],
  ['country', 'Economy'],
  ['indicator', 'Indicator'],
  ['label', 'Label'],
  ['year', 'Year'],
  ['value', 'Value'],
  ['type', 'Type'],
  ['unit', 'Unit'],
  ['vintage', 'Vintage'],
  ['source', 'Source'],
  ['sourceOrg', 'Source org'],
  ['sourceTier', 'Source tier'],
  ['sourceUrl', 'Source URL'],
  ['confidence', 'Confidence'],
  ['note', 'Note'],
] as const;

export interface WorkbookPlan {
  sheetName: string;
  evidenceSheetName: string;
  sections: WorkbookSection[];
  charts: ChartPlacement[];
  evidenceHeader: string[];
  evidenceRows: EvidenceRow[];
  caveats: string[];
  totalRows: number;
}

export interface IndicatorResult {
  evidence: DataEvidence;
  periodAverage: CalculationResult;
  /* Whichever of the two change calculations suits this series' unit. `name` travels with the
     values so the renderer labels the column from the plan rather than guessing. */
  change: { name: 'pp_change' | 'yoy_change'; results: CalculationResult[] };
}

// ── Sheet naming ───────────────────────────────────────────────────────────────────────────

function sanitiseSheetName(name: string): string {
  const cleaned = name.replace(SHEET_NAME_ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, SHEET_NAME_MAX) || 'Report';
}

/* Append a suffix while keeping the whole name inside Excel's 31-character limit, trimming the
   BASE rather than the suffix. Naively sanitising `base + suffix` truncates the suffix away, so
   a long base would yield an evidence sheet named identically to its report sheet — the two
   would then collide and the "Evidence" label would be lost entirely. */
function sheetNameWithSuffix(base: string, suffix: string): string {
  const cleanBase = sanitiseSheetName(base);
  const room = SHEET_NAME_MAX - suffix.length;
  return sanitiseSheetName(cleanBase.slice(0, room).trim() + suffix);
}

/* Plan §5: the renderer "never overwrites an existing sheet". The builder cannot see the
   workbook, so the task pane loads the real sheet names and passes them here — collision
   resolution stays a pure, testable function rather than an untestable Office.js branch.

   Suffixes as " (2)", " (3)"… and re-trims so the suffix cannot push the name past Excel's
   31-character limit (which would throw at add() time, defeating the point). Comparison is
   case-insensitive because Excel treats "Report" and "report" as the same sheet. */
export function resolveSheetName(base: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map(n => n.trim().toLowerCase()));
  const clean = sanitiseSheetName(base);
  if (!taken.has(clean.toLowerCase())) return clean;

  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = clean.slice(0, SHEET_NAME_MAX - suffix.length).trim() + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // 998 collisions on one base name is not a real workbook; fail loudly rather than loop.
  throw new Error(`resolveSheetName: could not find a free name based on "${base}".`);
}

// ── Chart spec ─────────────────────────────────────────────────────────────────────────────

/* Year range comes from the points actually retrieved, never from the requested window: asking
   for 1990-2024 and receiving 2015-2024 must produce a chart labelled 2015-2024, or the axis
   would imply coverage the hub does not have. */
export function buildChartSpecification(
  evidence: readonly DataEvidence[],
  intent: Pick<SingleCountryIntent, 'country'> | { countries: string[] },
): ChartSpec | null {
  if (!evidence.length) return null;

  const withValues = evidence.filter(e => e.points.some(p => p.value !== null));
  if (!withValues.length) return null;

  const years = withValues.flatMap(e => e.points.filter(p => p.value !== null).map(p => p.year));
  const countries = 'country' in intent ? [intent.country] : intent.countries;
  const first = withValues[0];
  const yearFrom = Math.min(...years);
  const yearTo = Math.max(...years);

  return {
    type: 'line',
    indicator: first.indicator,
    indicatorLabel: first.label,
    countries,
    yearFrom,
    yearTo,
    unit: first.unit,
    title: `${first.label} · ${countries.join(', ')} · ${yearFrom}–${yearTo}`,
    evidenceIds: withValues.map(e => evidenceId(e.country, e.indicator)),
  };
}

// ── Workbook plan ──────────────────────────────────────────────────────────────────────────

const CHART_COLUMN = 4;      // column E — clear of the 3-column table (Year, value, change)
const CHART_WIDTH_COLUMNS = 7;
const CHART_HEIGHT_ROWS = 15;
const SECTION_GAP = 2;       // blank rows between blocks, matching the at-cursor insert's feel

function changeColumnHeader(name: 'pp_change' | 'yoy_change'): string {
  return name === 'pp_change' ? 'Change (pp)' : 'Change (%)';
}

/* One indicator's table: title, subtitle, header, one row per retrieved year (gaps included as
   blank cells), then the period-average summary. Returns the section plus the next free row. */
function buildTableSection(result: IndicatorResult, startRow: number): TableSection {
  const { evidence, periodAverage, change } = result;
  const changeByYear = new Map(change.results.map(r => [r.year, r.value]));

  const header = ['Year', evidence.label, changeColumnHeader(change.name)];
  const dataRows: (string | number | null)[][] = evidence.points.map((p: DataPoint) => [
    p.year,
    p.value,
    changeByYear.get(p.year) ?? null,
  ]);

  const rows: (string | number | null)[][] = [
    [evidence.label, '', ''],
    [`${evidence.country} · ${evidence.unit}`, '', ''],
    header,
    ...dataRows,
    ['', '', ''],
    ['Period average', periodAverage.value, ''],
  ];

  const firstDataRowOffset = 3;
  const summaryRowOffset = firstDataRowOffset + dataRows.length + 1;

  return {
    kind: 'table',
    startRow,
    rowCount: rows.length,
    columnCount: 3,
    dataRowCount: dataRows.length,
    evidenceIds: [evidenceId(evidence.country, evidence.indicator)],
    indicator: evidence.indicator,
    label: evidence.label,
    unit: evidence.unit,
    header,
    rows,
    titleRowOffset: 0,
    headerRowOffset: 2,
    firstDataRowOffset,
    summaryRowOffsets: [summaryRowOffset],
  };
}

function buildListSection(
  kind: 'sources' | 'caveats',
  heading: string,
  rows: string[][],
  startRow: number,
): ListSection {
  return {
    kind,
    startRow,
    rowCount: rows.length + 1, // heading row plus the body
    columnCount: Math.max(1, ...rows.map(r => r.length)),
    heading,
    rows,
  };
}

/* Mixed units across a multi-indicator report are recorded as a caveat rather than silently
   tolerated — the same rule askTools.ts applies to an evidence package, restated here because a
   workbook outlives the request that produced it and has to carry its own warnings. */
function comparabilityCaveats(results: readonly IndicatorResult[]): string[] {
  if (results.length < 2) return [];
  const units = [...new Set(results.map(r => r.evidence.unit))];
  if (units.length < 2) return [];
  return [
    `This report mixes units (${units.join(', ')}). Indicators are shown in their own unit and ` +
      `must not be differenced, summed, or ranked against each other.`,
  ];
}

/* Retrieval misses become visible caveats. Plan §5/§6: a gap is reported, never quietly dropped —
   an analyst reading the sheet later has no other way to learn that something was asked for and
   not found. */
function missCaveats(misses: readonly RetrievalMiss[]): string[] {
  return misses.map(m => `Not retrieved (${m.kind}): ${m.detail}`);
}

export function buildWorkbookPlan(
  results: readonly IndicatorResult[],
  intent: SingleCountryIntent,
  misses: readonly RetrievalMiss[] = [],
): WorkbookPlan {
  const sections: WorkbookSection[] = [];
  const charts: ChartPlacement[] = [];
  const evidenceRows: EvidenceRow[] = [];

  let row = 0;
  for (const result of results) {
    const table = buildTableSection(result, row);
    sections.push(table);

    const spec = buildChartSpecification([result.evidence], intent);
    if (spec) {
      const dataRowCount = result.evidence.points.length;
      charts.push({
        spec,
        row: table.startRow,
        column: CHART_COLUMN,
        widthColumns: CHART_WIDTH_COLUMNS,
        heightRows: CHART_HEIGHT_ROWS,
        sourceStartRow: table.startRow + table.headerRowOffset,
        sourceRowCount: dataRowCount + 1, // include the header row so Excel names the series
        sourceValueColumn: 1,
      });
    }

    // A chart is taller than a short table, so the next block clears whichever is lower.
    const blockHeight = Math.max(table.rowCount, spec ? CHART_HEIGHT_ROWS : 0);
    row = table.startRow + blockHeight + SECTION_GAP;

    for (const point of result.evidence.points) {
      evidenceRows.push({
        evidenceId: evidenceId(result.evidence.country, result.evidence.indicator),
        country: result.evidence.country,
        indicator: result.evidence.indicator,
        label: result.evidence.label,
        year: point.year,
        value: point.value,
        type: point.type,
        unit: result.evidence.unit,
        vintage: result.evidence.vintage,
        source: result.evidence.source,
        sourceOrg: result.evidence.sourceOrg,
        sourceTier: result.evidence.sourceTier,
        sourceUrl: result.evidence.sourceUrl,
        confidence: result.evidence.confidence,
        note: result.evidence.note ?? '',
      });
    }
  }

  // Sources: one row per series, deduped, in the order the tables appear.
  const sourceRows = results.map(r => [
    r.evidence.label,
    r.evidence.source,
    r.evidence.sourceOrg,
    r.evidence.sourceTier,
    r.evidence.vintage,
    r.evidence.confidence,
    r.evidence.sourceUrl,
  ]);
  if (sourceRows.length) {
    const sources = buildListSection('sources', 'Sources', sourceRows, row);
    sections.push(sources);
    row = sources.startRow + sources.rowCount + SECTION_GAP;
  }

  const caveats = [
    ...comparabilityCaveats(results),
    ...results.filter(r => r.evidence.note).map(r => `${r.evidence.label}: ${r.evidence.note}`),
    ...missCaveats(misses),
  ];
  if (caveats.length) {
    const section = buildListSection('caveats', 'Caveats', caveats.map(c => [c]), row);
    sections.push(section);
    row = section.startRow + section.rowCount + SECTION_GAP;
  }

  /* Deliberately does not list the selected indicators: three slugs overflow 31 characters and
     truncate mid-word, and the name would then change every time the selection changed. A stable
     workflow name plus resolveSheetName's collision suffix reads better — "CaribEcon GY Deep
     Dive", then "… (2)" — and leaves exactly enough room for the " Evidence" companion. */
  const base = `CaribEcon ${intent.country} Deep Dive`;

  return {
    sheetName: sanitiseSheetName(base),
    evidenceSheetName: sheetNameWithSuffix(base, ' Evidence'),
    sections,
    charts,
    evidenceHeader: EVIDENCE_COLUMNS.map(([, heading]) => heading),
    evidenceRows,
    caveats,
    totalRows: row,
  };
}
