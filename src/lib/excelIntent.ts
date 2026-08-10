/* Validated Excel intent — Single Country Deep Dive and Country Comparison (plan §5, §6).

   Same discipline as askTools.ts's AskIntent: canonicalise raw input into a real hub country
   code / indicator slug, or drop it and record why as a RetrievalMiss. Nothing downstream —
   retrieval, calculation, chart, Excel write — ever sees a country or indicator that didn't
   resolve against the hub. Reuses askTools.ts's resolveCountry/resolveIndicator rather than
   duplicating canonicalisation (plan §8: "do not create a second Data Hub reader").

   Phase 2a/3a scope only: this validates explicit task-pane picker input (a <select>'s value
   is already a real hub code/slug by construction, but is validated the same way regardless —
   the picker and a future Interpreter's output must be indistinguishable to everything
   downstream). Natural-language interpretation is Phase 2b's Interpreter role; it will produce
   the same ExcelIntent shape from free text, not a parallel one. */

import { resolveCountry, resolveIndicator, type RetrievalMiss } from './askTools.js';

const MAX_INDICATORS = 3;
const MAX_COMPARISON_COUNTRIES = 6; // matches askTools.ts's comparison bound

export interface ExcelOutputs {
  table: boolean;
  charts: boolean;
  explanation: boolean; // Phase 2b only; always false until the Synthesis role exists
}

const DEFAULT_OUTPUTS: ExcelOutputs = { table: true, charts: true, explanation: false };

export interface SingleCountryIntent {
  workflow: 'single_country';
  country: string; // resolved 2-letter code
  indicators: string[]; // resolved hub slugs, 1-3
  yearFrom: number | null;
  yearTo: number | null;
  outputs: ExcelOutputs;
}

export interface CountryComparisonIntent {
  workflow: 'comparison';
  countries: string[]; // resolved 2-letter codes, 2+
  indicators: string[]; // resolved hub slugs, 1-3
  yearFrom: number | null;
  yearTo: number | null;
  outputs: ExcelOutputs;
}

export type ExcelIntent = SingleCountryIntent | CountryComparisonIntent;

export interface PickerInput {
  countries: string[]; // raw hub codes — length 1 for Single Country, 2+ for Comparison
  indicators: string[]; // raw hub slugs
  yearFrom?: number | null;
  yearTo?: number | null;
  outputs?: Partial<ExcelOutputs>;
}

function resolveIndicators(raw: string[]): { indicators: string[]; misses: RetrievalMiss[] } {
  const indicators: string[] = [];
  const misses: RetrievalMiss[] = [];

  for (const value of raw.slice(0, MAX_INDICATORS)) {
    const slug = resolveIndicator(value);
    if (slug) {
      if (!indicators.includes(slug)) indicators.push(slug);
    } else {
      misses.push({ kind: 'indicator', detail: `"${value}" is not an indicator the hub carries.` });
    }
  }
  if (!indicators.length) {
    misses.push({ kind: 'indicator', detail: 'No indicator was selected.' });
  }

  return { indicators, misses };
}

function resolveOutputs(raw: PickerInput['outputs']): ExcelOutputs {
  // explanation is never honored yet — Phase 2b doesn't exist — regardless of what a caller
  // asks for, so a stale request can't silently produce a narrative no Synthesis role wrote.
  return { ...DEFAULT_OUTPUTS, ...raw, explanation: false };
}

/* One country. A picker request with zero or 2+ countries is a caller error, not silently
   narrowed to the first — see validateComparisonPicker for the 2+ case. */
export function validateSingleCountryPicker(
  input: PickerInput,
): { intent: SingleCountryIntent | null; misses: RetrievalMiss[] } {
  const misses: RetrievalMiss[] = [];

  if (input.countries.length !== 1) {
    misses.push({
      kind: 'country',
      detail: `Single Country Deep Dive needs exactly one economy; got ${input.countries.length}.`,
    });
  }

  const country = input.countries.length === 1 ? resolveCountry(input.countries[0]) : null;
  if (input.countries.length === 1 && !country) {
    misses.push({ kind: 'country', detail: `"${input.countries[0]}" is not one of the 19 economies in the hub.` });
  }

  const { indicators, misses: indicatorMisses } = resolveIndicators(input.indicators);
  misses.push(...indicatorMisses);

  if (!country || !indicators.length) {
    return { intent: null, misses };
  }

  return {
    intent: {
      workflow: 'single_country',
      country,
      indicators,
      yearFrom: input.yearFrom ?? null,
      yearTo: input.yearTo ?? null,
      outputs: resolveOutputs(input.outputs),
    },
    misses,
  };
}

/* 2+ countries. Plan §5: "Missing countries must never silently become an all-region
   comparison" — an unresolved or missing country is reported as a miss and the whole request
   fails closed, it never falls back to comparing every economy the hub has. */
export function validateComparisonPicker(
  input: PickerInput,
): { intent: CountryComparisonIntent | null; misses: RetrievalMiss[] } {
  const misses: RetrievalMiss[] = [];

  if (input.countries.length < 2) {
    misses.push({
      kind: 'country',
      detail: `A comparison needs at least two economies; got ${input.countries.length}.`,
    });
  }

  const countries: string[] = [];
  for (const value of input.countries.slice(0, MAX_COMPARISON_COUNTRIES)) {
    const code = resolveCountry(value);
    if (code) {
      if (!countries.includes(code)) countries.push(code);
    } else {
      misses.push({ kind: 'country', detail: `"${value}" is not one of the 19 economies in the hub.` });
    }
  }

  // Enough raw values were supplied, but too few resolved — say so explicitly rather than
  // leaving the shortfall only implied by the per-code misses above. The `< 2` check before
  // this loop already covers "too few raw entries"; this covers "resolution shrank them".
  if (countries.length < 2 && input.countries.length >= 2) {
    misses.push({
      kind: 'country',
      detail: `A comparison needs at least two economies; only ${countries.length} of ${input.countries.length} requested resolved.`,
    });
  }

  const { indicators, misses: indicatorMisses } = resolveIndicators(input.indicators);
  misses.push(...indicatorMisses);

  if (countries.length < 2 || !indicators.length) {
    return { intent: null, misses };
  }

  return {
    intent: {
      workflow: 'comparison',
      countries,
      indicators,
      yearFrom: input.yearFrom ?? null,
      yearTo: input.yearTo ?? null,
      outputs: resolveOutputs(input.outputs),
    },
    misses,
  };
}
