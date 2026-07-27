/* XLSX export for the Data-page line chart — bundles the currently displayed
   indicator/country selection into a single-sheet workbook via SheetJS, so
   every download on the Data page (chart export + per-country export) is
   the same .xlsx format. No DOM side effects except triggering the download. */

import * as XLSX from 'xlsx';

interface Row {
  country: string;
  indicator: string;
  indicator_label: string;
  unit: string;
  year: number;
  value: number | null;
  type: string;
  source: string;
  vintage?: string;
}

/** Sizes each column to its widest cell (in characters) so nothing clips in Excel. */
function fitColumns(ws: XLSX.WorkSheet, aoa: (string | number | null | undefined)[][]) {
  const widths: number[] = [];
  aoa.forEach(row => {
    row.forEach((cell, c) => {
      const len = cell === null || cell === undefined ? 0 : String(cell).length;
      widths[c] = Math.max(widths[c] ?? 0, len);
    });
  });
  ws['!cols'] = widths.map(w => ({ wch: Math.min(48, Math.max(8, w + 2)) }));
}

/** Builds and downloads a single-sheet .xlsx for the given chart rows. */
export function downloadChartXLSX(rows: Row[], filename: string): void {
  if (rows.length === 0) return;

  const headers = ['Country', 'Indicator', 'Indicator label', 'Unit', 'Year', 'Value', 'Type', 'Source', 'Vintage'];
  const aoa: (string | number | null | undefined)[][] = [
    headers,
    ...rows.map(r => [
      r.country, r.indicator, r.indicator_label, r.unit, r.year, r.value, r.type, r.source, r.vintage ?? '',
    ]),
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  fitColumns(ws, aoa);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}
