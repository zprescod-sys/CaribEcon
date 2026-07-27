/* Budget audit-table export.

   Publishes, for one budget pie, every input needed to re-derive it from the
   official document: segment, local-currency amount, share of total, the
   denominator and what it measures, the source document and the page each
   figure came from, and whether the figure was transcribed or derived here.

   The pie itself may roll the smallest segments into one "other" slice for
   legibility; this export never does — it always carries every published line
   item, so the pie's percentage logic, rounding and residual treatment can be
   checked independently. */

import * as XLSX from 'xlsx';
import type { BudgetEntry } from './types';

/** Sizes each column to its widest cell so nothing clips in Excel. */
function fitColumns(ws: XLSX.WorkSheet, aoa: (string | number | null)[][]) {
  const widths: number[] = [];
  aoa.forEach(row => row.forEach((cell, c) => {
    const len = cell === null || cell === undefined ? 0 : String(cell).length;
    widths[c] = Math.max(widths[c] ?? 0, len);
  }));
  ws['!cols'] = widths.map(w => ({ wch: Math.min(70, Math.max(10, w + 2)) }));
}

/** Builds the audit worksheet for one country's budget. */
export function buildBudgetAuditSheet(budget: BudgetEntry, countryName: string) {
  // Rounded to 6dp: amounts are dollars-in-millions, so naive summation leaves
  // float noise (…158999999) that reads as false precision in an audit document.
  const segTotal = Number(budget.categories.reduce((s, c) => s + c.amount, 0).toFixed(6));
  const aoa: (string | number | null)[][] = [];

  aoa.push([`CaribEcon — budget audit table — ${countryName}`]);
  aoa.push(['Fiscal year', budget.fiscalYear]);
  aoa.push(['Currency', `${budget.currency} (${budget.currencySymbol}), millions — as printed in the source; no FX conversion applied`]);
  aoa.push(['Denominator', `${budget.total}`, budget.denominator]);
  aoa.push(['Basis', budget.basis]);
  aoa.push(['Coverage', budget.coverage]);
  aoa.push(['Source', budget.source]);
  aoa.push(['Source document', budget.sourceDocument]);
  aoa.push(['Source URL', budget.sourceUrl]);
  aoa.push(['Page for total', budget.sourcePage]);
  if (budget.note) aoa.push(['Note', budget.note]);
  aoa.push(['Segments sum to', segTotal, segTotal === budget.total
    ? 'equals the published total exactly'
    : `differs from the published total by ${Number((segTotal - budget.total).toFixed(6))} (${((segTotal - budget.total) / budget.total * 100).toFixed(4)}%) — see Note`]);
  aoa.push([]);

  aoa.push([
    'Country', 'Fiscal year', 'Segment',
    `Amount (${budget.currency} mn)`, 'Share of segments (%)', 'Share of published total (%)',
    'Denominator', 'Provenance', 'Source document', 'Source page', 'Note',
  ]);

  // Largest first, matching the order the pie draws them in
  [...budget.categories].sort((a, b) => b.amount - a.amount).forEach(c => {
    aoa.push([
      budget.country,
      budget.fiscalYear,
      c.name,
      c.amount,
      Number(((c.amount / segTotal) * 100).toFixed(4)),
      Number(((c.amount / budget.total) * 100).toFixed(4)),
      budget.total,
      c.derived ? 'Derived here — not a published line item' : 'Transcribed from source',
      budget.sourceDocument,
      c.sourcePage,
      c.note ?? '',
    ]);
  });

  aoa.push([]);
  aoa.push(['TOTAL', '', `${budget.categories.length} segments`, segTotal, 100, Number((segTotal / budget.total * 100).toFixed(4))]);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  fitColumns(ws, aoa);
  return ws;
}

/** Builds and downloads the audit table for one country. */
export function exportBudgetAudit(budget: BudgetEntry, countryName: string): boolean {
  if (!budget?.categories?.length) return false;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildBudgetAuditSheet(budget, countryName), 'Budget audit');
  XLSX.writeFile(wb, `caribecon-budget-audit-${budget.country.toLowerCase()}-${budget.year}.xlsx`);
  return true;
}
