/* Per-country Excel export for the 25-indicator almanac dataset.
   Reads almanac-data.json, builds a multi-sheet .xlsx and triggers a download.

   Note on charts: the community build of SheetJS cannot draw native Excel
   charts, so the three required chart sheets ship as clean, chart-ready
   Year/Value tables (select the range → Insert → Chart). The "Data" sheet
   carries the full time series with units and source attribution. */

import * as XLSX from 'xlsx';

export interface AlmanacPoint {
  year: number;
  value: number | null;
  type: string;
  vintage?: string;
  sourceNote?: string;
}

export interface AlmanacRecord {
  country: string;
  indicator: string;
  indicatorLabel: string;
  unit: string;
  unitNote?: string;
  source: string;
  sourceOrg: string;
  sourceTier: string;
  sourceUrl?: string;
  sourceRef?: string;
  confidence: string;
  series: AlmanacPoint[];
}

// Canonical indicator order (matches data/SCHEMA.md)
const INDICATOR_ORDER = [
  'nominal_gdp', 'real_gdp', 'gdp_growth', 'gdp_per_capita',
  'population', 'inflation', 'fx_rate_usd', 'unemployment', 'labour_participation',
  'dependency_ratio', 'fdi', 'monetary_base', 'current_account', 'capital_account',
  'primary_balance', 'fiscal_balance', 'govt_revenue_total', 'govt_current_expenditure',
  'govt_capital_expenditure', 'govt_total_expenditure', 'gross_govt_debt',
  'net_govt_debt', 'gross_govt_debt_pct_gdp', 'import_cover',
];

const MIN_YEAR = 2015;

/** Country codes that have at least one record in the dataset. */
export function countriesWithData(records: AlmanacRecord[]): string[] {
  return [...new Set(records.map(r => r.country))];
}

/** Sorts a country's records into canonical indicator order. */
function orderedRecords(records: AlmanacRecord[], country: string): AlmanacRecord[] {
  const forCountry = records.filter(r => r.country === country);
  return forCountry.sort(
    (a, b) => INDICATOR_ORDER.indexOf(a.indicator) - INDICATOR_ORDER.indexOf(b.indicator),
  );
}

/** Every year (>= MIN_YEAR) present across a country's series, ascending. */
function yearAxis(records: AlmanacRecord[]): number[] {
  const years = new Set<number>();
  records.forEach(r => r.series.forEach(p => { if (p.year >= MIN_YEAR) years.add(p.year); }));
  return [...years].sort((a, b) => a - b);
}

/** Look up one indicator's value for a given year (null if absent). */
function valueAt(rec: AlmanacRecord, year: number): number | null {
  return rec.series.find(p => p.year === year)?.value ?? null;
}

/** Sizes each column to its widest cell (in characters) so nothing is clipped in
 *  Excel. Widths are clamped to a sensible band and padded slightly for breathing
 *  room; ragged rows (short title rows) are handled — a column only grows to fit
 *  the cells that actually exist in it. */
function fitColumns(
  ws: XLSX.WorkSheet,
  aoa: (string | number | null)[][],
  { min = 6, max = 64 }: { min?: number; max?: number } = {},
) {
  const widths: number[] = [];
  aoa.forEach(row => {
    row.forEach((cell, c) => {
      const len = cell === null || cell === undefined ? 0 : String(cell).length;
      widths[c] = Math.max(widths[c] ?? 0, len);
    });
  });
  ws['!cols'] = widths.map(w => ({ wch: Math.min(max, Math.max(min, w + 2)) }));
}

/** Builds the wide "Data" sheet: one row per indicator, one column per year.
 *  Source tier and provenance-confidence are intentionally omitted — they are
 *  internal QA fields, not something a reader of the export needs. */
function buildDataSheet(recs: AlmanacRecord[], years: number[], countryName: string, code: string) {
  const aoa: (string | number | null)[][] = [];
  aoa.push([`CaribEcon — ${countryName} (${code})`]);
  aoa.push([`Generated ${new Date().toISOString().slice(0, 10)}`,
            years.length ? `Range FY${years[0]}–FY${years[years.length - 1]}` : 'No data']);
  aoa.push([]);
  aoa.push(['Indicator', 'Unit', ...years.map(y => `FY${y}`), 'Source', 'Source ref']);

  recs.forEach(r => {
    aoa.push([
      r.indicatorLabel,
      r.unit,
      ...years.map(y => valueAt(r, y)),
      r.source,
      r.sourceRef ?? '',
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  fitColumns(ws, aoa);
  return ws;
}

/** Builds a chart-ready Year/Value sheet for a single indicator. */
function buildChartSheet(rec: AlmanacRecord | undefined, title: string, years: number[]) {
  const aoa: (string | number | null)[][] = [];
  if (!rec) {
    aoa.push([title], [], ['No data available for this indicator yet.']);
    const empty = XLSX.utils.aoa_to_sheet(aoa);
    fitColumns(empty, aoa);
    return empty;
  }
  aoa.push([`${rec.indicatorLabel} (${rec.unit}) — ${title}`]);
  aoa.push([rec.source]);
  aoa.push([]);
  aoa.push(['Year', rec.indicatorLabel]);
  years.forEach(y => {
    const v = valueAt(rec, y);
    if (v !== null) aoa.push([y, v]);
  });
  aoa.push([], ['To chart: select the Year/value range above → Insert → Chart.']);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  fitColumns(ws, aoa);
  return ws;
}

/** Builds the full workbook for one country. Returns null if no data exists. */
export function buildCountryWorkbook(
  records: AlmanacRecord[], country: string, countryName: string,
): XLSX.WorkBook | null {
  const recs = orderedRecords(records, country);
  if (recs.length === 0) return null;

  const years = yearAxis(recs);
  const find = (slug: string) => recs.find(r => r.indicator === slug);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildDataSheet(recs, years, countryName, country), 'Data');
  XLSX.utils.book_append_sheet(wb, buildChartSheet(find('nominal_gdp'), 'Nominal GDP Chart', years), 'Nominal GDP Chart');
  XLSX.utils.book_append_sheet(wb, buildChartSheet(find('real_gdp'), 'Real GDP Chart', years), 'Real GDP Chart');
  XLSX.utils.book_append_sheet(wb, buildChartSheet(find('govt_revenue_total'), 'Gov Revenue Chart', years), 'Gov Revenue Chart');
  return wb;
}

/** Builds and downloads the .xlsx for a country. Returns false if no data. */
export function exportCountryXLSX(
  records: AlmanacRecord[], country: string, countryName: string,
): boolean {
  const wb = buildCountryWorkbook(records, country, countryName);
  if (!wb) return false;
  XLSX.writeFile(wb, `caribecon-${country.toLowerCase()}.xlsx`);
  return true;
}
