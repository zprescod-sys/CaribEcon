/* CSV export — pure function that converts a dataset to a CSV download.
   No DOM side effects except triggering the browser download. */

interface Row {
  [key: string]: string | number | null | undefined;
}

export function downloadCSV(rows: Row[], filename: string): void {
  if (rows.length === 0) return;

  const headers = Object.keys(rows[0]);
  const csvLines = [
    headers.join(','),
    ...rows.map(row =>
      headers.map(h => {
        const val = row[h];
        if (val === null || val === undefined) return '';
        const str = String(val);
        // Quote fields that contain commas, quotes, or newlines
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(',')
    ),
  ];

  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** Converts indicator series data to flat rows for CSV export. */
export function seriestoRows(
  series: Array<{ country: string; indicator: string; year: number; value: number | null; type: string; source: string }>,
): Row[] {
  return series.map(d => ({
    country:   d.country,
    indicator: d.indicator,
    year:      d.year,
    value:     d.value,
    type:      d.type,
    source:    d.source,
  }));
}
