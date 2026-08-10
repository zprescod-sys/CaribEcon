/* Deterministic calculation registry — Single Country Deep Dive and Country Comparison
   (plan §5, §6, §8). A model may only ever NAME one of these functions from a validated
   ResearchPlan; it never computes a value itself. Every function here is pure: the same
   DataPoint[] in always produces the same result out, no I/O, no randomness. A new
   calculation belongs here with a test — never inline in a workflow, endpoint, or prompt. */

import type { DataPoint } from './askTools.js';

export interface CalculationResult {
  year: number;
  value: number | null;   // null when the inputs don't support a value at this year
  inputYears: number[];   // source years behind this value — what a Verification role
                           // (plan §5) or the Evidence sheet (plan §6) checks lineage against
}

/* Year-over-year percentage change, one result per year present in the input. Requires a
   non-null value at both the target year and the immediately preceding year — never
   interpolates across a gap, since a gap-spanning "YoY" figure would misstate the rate. A
   zero-valued prior year is also refused: division by zero has no meaningful percentage. */
export function yoy_change(points: DataPoint[]): CalculationResult[] {
  const byYear = new Map(points.map(p => [p.year, p]));
  const years = [...byYear.keys()].sort((a, b) => a - b);

  return years.map(year => {
    const current = byYear.get(year)!;
    const previous = byYear.get(year - 1);
    const inputYears = previous ? [year - 1, year] : [year];

    if (current.value === null || !previous || previous.value === null || previous.value === 0) {
      return { year, value: null, inputYears };
    }

    const value = ((current.value - previous.value) / Math.abs(previous.value)) * 100;
    return { year, value, inputYears };
  });
}

/* Arithmetic mean over the supplied range, stamped on the latest year in that range for
   display. Points with a null value (hub gaps) are excluded from both the sum and the
   count — a missing year must never silently pull the average down. */
export function period_average(points: DataPoint[]): CalculationResult {
  const withValue = points.filter(p => p.value !== null);
  if (!withValue.length) {
    return { year: NaN, value: null, inputYears: [] };
  }

  const years = withValue.map(p => p.year).sort((a, b) => a - b);
  const sum = withValue.reduce((total, p) => total + (p.value as number), 0);

  return {
    year: years[years.length - 1],
    value: sum / withValue.length,
    inputYears: years,
  };
}

export const CALCULATION_REGISTRY = {
  yoy_change,
  period_average,
} as const;

export type CalculationName = keyof typeof CALCULATION_REGISTRY;
