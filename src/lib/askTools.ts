/* Ask CaribEcon — deterministic retrieval facade.

   Everything a model is ever allowed to see about the hub passes through here, and everything
   here is plain code: no LLM, no network, same inputs to same outputs every time. That is the
   point. The Interpreter decides WHAT to ask for and the Synthesizer decides how to say it, but
   neither ever touches a number or a URL — those come out of this file, traceable to a stored
   record. A citation that cannot be traced to an EvidencePackage entry is a bug, not a style
   choice.

   Nodenext-safe by construction (explicit .js specifiers, JSON reached only through the two
   modules below) so api/ask.ts can import it. Never import dataHub.ts from this path — see the
   header of indicators.ts.

   Phase 0 of plans/CaribEcon_AskCaribEcon_Refined_Build_Prompt.md: retrieval only. Response
   assembly (sources, keyData, followUps) belongs to api/ask.ts in Phase 1. */

import type { IndicatorSeries } from './types.js';
import {
  getCountries,
  getIndicatorMeta,
  getFeaturedIndicators,
  getSeries,
  getIndicatorAllCountries,
} from './indicators.js';
import { searchNews, getNewsCoverage, type NewsEvidence } from './news.js';
import type { EvidenceMeta, WebEvidence, ResearchPlan, ResearchStep } from './ai/contracts.js';
import { MAX_PLAN_STEPS } from './ai/config.js';

export type { NewsEvidence };

// ── Intent ─────────────────────────────────────────────────────────────────────────────────

export type AskQuestionType = 'indicator' | 'comparison' | 'news';

export interface AskIntent {
  questionType: AskQuestionType;
  countries: string[];    // resolved 2-letter codes
  indicators: string[];   // resolved hub slugs
  yearFrom: number | null;
  yearTo: number | null;
  newsKeywords: string[];
}

// ── Evidence ───────────────────────────────────────────────────────────────────────────────

export interface DataPoint {
  year: number;
  value: number | null;   // null = the hub has no figure; never fill one in
  type: string;           // actual | estimate | projection | derived
}

export interface DataEvidence {
  country: string;
  indicator: string;
  label: string;
  unit: string;           // taken from the SERIES, not from indicator meta — see listIndicators
  source: string;
  sourceOrg: string;
  sourceTier: string;
  sourceUrl: string;
  vintage: string;
  confidence: string;
  note?: string;          // seriesNote: source-divergence and comparability caveats
  points: DataPoint[];
}

/* What was asked for and could not be served. Kept as data rather than thrown away so the
   answer can name the gap — an unretrievable subtask becomes a visible caveat, never a silent
   drop or a guess. */
export interface RetrievalMiss {
  /* 'step' is validateResearchPlan's own addition (Phase 3, §2b): none of the existing five kinds
     name "a plan step's own structure was invalid" — country/indicator are about a resolved
     value, series/years are about what a resolved query returned, news is about a search result.
     A dropped extract_web step (bad or cascaded-invalid onStep) is a different failure shape —
     the step itself never became an authorized retrieval at all — so it earns its own kind rather
     than being force-fit into 'series' (which implies a query ran) or 'indicator'/'country'
     (which imply a name failed to resolve). */
  kind: 'country' | 'indicator' | 'series' | 'years' | 'news' | 'step';
  detail: string;
}

/* Stable evidence ID (plan §5: "every retrieved series and news item has a stable evidence ID").
   Derived from the record's own identity rather than assigned by position, so the same series
   carries the same ID across requests and a figure in the report can be traced to its lineage
   row on the Evidence sheet. Lives here, not in excelOutputs.ts (which re-exports it
   unchanged): evidence identity is this module's domain, and it is also what backs the `D:`
   EvidenceRef prefix (ARCHITECTURE.md §2.5) — a research-pipeline concept that has nothing to
   do with Excel output planning. */
export function evidenceId(country: string, indicator: string): string {
  return `${country}:${indicator}`;
}

/* Retrieved, but constrained in a way the writer must respect — chiefly local-currency levels
   that must not be ranked or differenced across countries. An addition to the plan's suggested
   EvidencePackage: `misses` covers what is absent, and conflating "missing" with "present but
   not comparable" is exactly how an incompatible comparison gets written. */
export interface EvidencePackage {
  data: DataEvidence[];
  news: NewsEvidence[];
  misses: RetrievalMiss[];
  caveats: string[];
  toolsUsed: string[];
  newsCoverage: { earliest: string; latest: string; count: number };
  /* Turn-local, never accepted back from a client (ARCHITECTURE.md §2.4 C3) — absent here
     because this deterministic path never calls Tavily. The Research Agent's equivalent
     evidence-package builder (Phase 3) is what actually populates this. */
  web?: WebEvidence[];
  /* One entry per unique EvidenceRef pulled into this package, populated below at the moment
     each ref is resolved — ARCHITECTURE.md §2.5. */
  evidenceMeta: EvidenceMeta[];
}

// Bounds — a model is never sent more than it needs, on cost and on focus alike.
const MAX_COMPARISON_COUNTRIES = 6;
const MAX_INDICATORS = 3;
const MAX_NEWS = 6;

// ── Canonicalisation ───────────────────────────────────────────────────────────────────────

/* Fold the spellings a model actually emits onto one key: case, diacritics ("Curacao" for
   "Curaçao"), punctuation, "&" vs "and", "St." vs "Saint", American vs British spelling (the hub
   itself uses British spelling, e.g. "Labour Force Participation Rate" — a model defaulting to
   American English otherwise fails on that alone). Applied to both sides of every comparison, so
   the hub's own labels need no special-casing.

   newsSearch.ts has a near-identical normalise() and this is deliberately not shared with it:
   that module uses extensionless specifiers and would break this file's nodenext safety. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/&/g, ' and ')
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/\blabor\b/g, 'labour')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Forms the hub's own country names don't produce but a model reliably will.
const COUNTRY_ALIASES: Record<string, string> = {
  'trinidad': 'TT',
  'the bahamas': 'BS',
  'bahamas the': 'BS',
  'saint vincent': 'VC',
  'saint vincent and grenadines': 'VC',
  'saint kitts': 'KN',
  'british virgin islands bvi': 'VG',
  'turks and caicos islands': 'TC',
  'curacao': 'CW',
};

const countryByKey = (() => {
  const map = new Map<string, string>();
  for (const c of getCountries()) {
    map.set(normalise(c.code), c.code);
    map.set(normalise(c.name), c.code);
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) map.set(normalise(alias), code);
  return map;
})();

/* Phrasing the hub's own slug/label doesn't already catch, verified against data/SCHEMA.md's
 * indicator definitions and sourcing notes before being added — not just plausible-sounding
 * English. Each entry must map unambiguously to exactly ONE hub slug; a phrase that could
 * plausibly mean any of several real hub indicators (bare "government debt" — gross, net, or the
 * ratio; bare "government spending" — current, capital, or total) is deliberately left OUT and
 * must stay unresolved rather than guess. See evidenceCompiler.test.mjs / askTools.test.mjs for
 * the negative tests asserting those specific ambiguous phrases stay null. */
const INDICATOR_ALIASES: Record<string, string> = {
  'nominal gross domestic product': 'nominal_gdp',
  'gdp at current prices': 'nominal_gdp',
  'real gross domestic product': 'real_gdp',
  'gdp in constant prices': 'real_gdp',
  'constant price gdp': 'real_gdp',
  'gdp at constant prices': 'real_gdp',
  'economic growth': 'gdp_growth',
  'rate of economic growth': 'gdp_growth',
  'rate of gdp growth': 'gdp_growth',
  'per capita gdp': 'gdp_per_capita',
  'income per person': 'gdp_per_capita',
  'per capita income': 'gdp_per_capita',
  'gdp per person': 'gdp_per_capita',
  'total population': 'population',
  'number of inhabitants': 'population',
  'number of people': 'population',
  'cpi inflation': 'inflation',
  'consumer price inflation': 'inflation',
  'price inflation': 'inflation',
  'headline inflation': 'inflation',
  'rate of inflation': 'inflation',
  'usd exchange rate': 'fx_rate_usd',
  'dollar exchange rate': 'fx_rate_usd',
  'us dollar exchange rate': 'fx_rate_usd',
  'joblessness': 'unemployment',
  'rate of unemployment': 'unemployment',
  'labour force participation': 'labour_participation',
  'workforce participation rate': 'labour_participation',
  'workforce participation': 'labour_participation',
  'age dependency ratio': 'dependency_ratio',
  'foreign direct investment': 'fdi',
  'net foreign direct investment': 'fdi',
  'direct investment inflows': 'fdi',
  'base money': 'monetary_base',
  'reserve money': 'monetary_base',
  'm0': 'monetary_base',
  'current account balance': 'current_account',
  'current account deficit': 'current_account',
  'current account surplus': 'current_account',
  'capital account balance': 'capital_account',
  'capital account deficit': 'capital_account',
  'capital account surplus': 'capital_account',
  'primary deficit': 'primary_balance',
  'primary surplus': 'primary_balance',
  'primary fiscal balance': 'primary_balance',
  'budget balance': 'fiscal_balance',
  'budget deficit': 'fiscal_balance',
  'fiscal deficit': 'fiscal_balance',
  'overall fiscal balance': 'fiscal_balance',
  'budget surplus': 'fiscal_balance',
  'fiscal surplus': 'fiscal_balance',
  'government revenue': 'govt_revenue_total',
  'total government revenue': 'govt_revenue_total',
  'fiscal revenue': 'govt_revenue_total',
  'state revenue': 'govt_revenue_total',
  'public revenue': 'govt_revenue_total',
  'current expenditure': 'govt_current_expenditure',
  'recurrent expenditure': 'govt_current_expenditure',
  'government current spending': 'govt_current_expenditure',
  'recurrent spending': 'govt_current_expenditure',
  'capital expenditure': 'govt_capital_expenditure',
  'capital spending': 'govt_capital_expenditure',
  'government capital spending': 'govt_capital_expenditure',
  'total government expenditure': 'govt_total_expenditure',
  'total government spending': 'govt_total_expenditure',
  'gross public debt': 'gross_govt_debt',
  'gross debt': 'gross_govt_debt',
  'net public debt': 'net_govt_debt',
  'net debt': 'net_govt_debt',
  'debt to gdp': 'gross_govt_debt_pct_gdp',
  'debt to gdp ratio': 'gross_govt_debt_pct_gdp',
  'government debt as a percentage of gdp': 'gross_govt_debt_pct_gdp',
  'public debt to gdp ratio': 'gross_govt_debt_pct_gdp',
  'government debt ratio': 'gross_govt_debt_pct_gdp',
  'months of import cover': 'import_cover',
  'reserve cover': 'import_cover',
};

const indicatorByKey = (() => {
  const map = new Map<string, string>();
  for (const m of getIndicatorMeta()) {
    map.set(normalise(m.slug), m.slug);
    map.set(normalise(m.label), m.slug);
  }
  for (const [alias, slug] of Object.entries(INDICATOR_ALIASES)) map.set(normalise(alias), slug);
  return map;
})();

/* Resolve to a real hub code, or to null. Never to a guess: an unresolvable country is reported
   as a miss and dropped, because a plausible-looking wrong code produces a confidently wrong
   answer, which is the failure mode this whole path exists to prevent. */
export function resolveCountry(value: string): string | null {
  return countryByKey.get(normalise(value)) ?? null;
}

/* Retired schema identifiers that must never resolve again — data/SCHEMA.md's own words for
 * `debt_to_gdp`: "Do not reintroduce a separate debt_to_gdp slug." normalise() would otherwise
 * fold this machine slug onto the exact same key as the natural-language phrase "debt to GDP"
 * (both become "debt to gdp" once underscores/spaces are collapsed) — but those are two different
 * things colliding by normalization coincidence, not one real ambiguity: the retired PROGRAMMATIC
 * IDENTIFIER must stay dead, while "debt to GDP" is a perfectly valid, current way to name
 * gross_govt_debt_pct_gdp (the slug it was merged into) and has every right to keep resolving.
 * Checked against the raw, lightly-cleaned input — NOT the fully normalised form — so this only
 * ever catches the literal retired spelling, never a natural phrase that happens to share its
 * normalised key. */
const RETIRED_INDICATOR_SLUGS = new Set(['debt_to_gdp']);

export function resolveIndicator(value: string): string | null {
  if (RETIRED_INDICATOR_SLUGS.has(value.trim().toLowerCase())) return null;
  return indicatorByKey.get(normalise(value)) ?? null;
}

/* Validate raw Interpreter output into an AskIntent the retriever can trust. Anything that does
   not resolve is stripped and recorded — the model does not get to invent a slug. */
export function canonicaliseIntent(raw: unknown): { intent: AskIntent; misses: RetrievalMiss[] } {
  const input = (raw ?? {}) as Record<string, unknown>;
  const misses: RetrievalMiss[] = [];

  const rawType = String(input.questionType ?? '').toLowerCase();
  const questionType: AskQuestionType =
    rawType === 'comparison' || rawType === 'news' ? rawType : 'indicator';

  const countries: string[] = [];
  for (const value of toStringArray(input.countries)) {
    const code = resolveCountry(value);
    if (code) {
      if (!countries.includes(code)) countries.push(code);
    } else {
      misses.push({ kind: 'country', detail: `"${value}" is not one of the 19 economies in the hub.` });
    }
  }

  const indicators: string[] = [];
  for (const value of toStringArray(input.indicators)) {
    const slug = resolveIndicator(value);
    if (slug) {
      if (!indicators.includes(slug)) indicators.push(slug);
    } else {
      misses.push({ kind: 'indicator', detail: `"${value}" is not an indicator the hub carries.` });
    }
  }

  return {
    intent: {
      questionType,
      countries,
      indicators,
      yearFrom: toYear(input.yearFrom),
      yearTo: toYear(input.yearTo),
      newsKeywords: toStringArray(input.newsKeywords).slice(0, 8),
    },
    misses,
  };
}

/* Validate a Planner-emitted ResearchPlan the same way canonicaliseIntent validates raw
   Interpreter output: every named country/indicator goes through resolveCountry/resolveIndicator,
   and anything that does not resolve is stripped and recorded rather than kept or guessed. The
   Planner (plan.ts, Phase 3) only checks structural validity — right shape, valid tool enum; this
   is the one place that checks the plan's claims against the real hub.

   Steps are walked in order and appended to `validated` as each survives, so `extract_web`'s
   onStep check only ever sees already-validated earlier steps — a search_web step dropped for
   any reason silently takes every extract_web step that depended on it with it (cascading drop),
   with no separate bookkeeping required: the dependency just never appears in `validated` to be
   found. That is exactly what "an extract must follow a validated search, or it is not
   authorized" (WebEvidence.authorizedBy, contracts.ts) needs to mean — a Tavily Extract call must
   trace back to a real, resolved search step, never to a step name a model merely wrote down. */
export function validateResearchPlan(
  plan: ResearchPlan,
): { plan: ResearchPlan; misses: RetrievalMiss[] } {
  const misses: RetrievalMiss[] = [];
  const validated: ResearchStep[] = [];

  for (const step of plan.steps) {
    if (step.tool === 'get_series') {
      const country = resolveCountry(step.country);
      const indicator = resolveIndicator(step.indicator);
      if (!country) {
        misses.push({ kind: 'country', detail: `"${step.country}" is not one of the 19 economies in the hub.` });
        continue;
      }
      if (!indicator) {
        misses.push({ kind: 'indicator', detail: `"${step.indicator}" is not an indicator the hub carries.` });
        continue;
      }
      validated.push({ ...step, country, indicator });
    } else if (step.tool === 'compare_series') {
      const countries: string[] = [];
      for (const value of step.countries) {
        const code = resolveCountry(value);
        if (code) {
          if (!countries.includes(code)) countries.push(code);
        } else {
          misses.push({ kind: 'country', detail: `"${value}" is not one of the 19 economies in the hub.` });
        }
      }
      // Partial-keep, same as canonicaliseIntent — only drop the whole step if EVERY country failed.
      if (!countries.length) continue;

      const indicator = resolveIndicator(step.indicator);
      if (!indicator) {
        misses.push({ kind: 'indicator', detail: `"${step.indicator}" is not an indicator the hub carries.` });
        continue;
      }
      validated.push({ ...step, countries, indicator });
    } else if (step.tool === 'search_news') {
      const countries: string[] = [];
      for (const value of step.countries) {
        const code = resolveCountry(value);
        if (code) {
          if (!countries.includes(code)) countries.push(code);
        } else {
          misses.push({ kind: 'country', detail: `"${value}" is not one of the 19 economies in the hub.` });
        }
      }
      // An empty result is fine — searchNews already treats no countries as pan-Caribbean.
      validated.push({ ...step, countries });
    } else if (step.tool === 'search_web') {
      // No country/indicator to resolve; plan.ts already checked structural validity.
      validated.push(step);
    } else {
      // extract_web: onStep must name an EARLIER step that already survived validation as
      // search_web — never the raw, unvalidated plan.steps array (that would let an extract ride
      // in on a search step that itself got dropped for naming a bad country/indicator... except
      // search_web has neither, but the discipline generalises: only a resolved authorization
      // counts).
      const target = validated.find(s => s.id === step.onStep);
      if (!target || target.tool !== 'search_web') {
        misses.push({
          kind: 'step',
          detail: `extract_web step "${step.id}" names onStep "${step.onStep}", which is not a valid, earlier search_web step.`,
        });
        continue;
      }
      validated.push(step);
    }
  }

  return {
    plan: {
      question: plan.question,
      scope: plan.scope,
      steps: validated.slice(0, MAX_PLAN_STEPS),
      anticipatedGaps: plan.anticipatedGaps,
    },
    misses,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function toYear(value: unknown): number | null {
  const year = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

// ── Deterministic tools ────────────────────────────────────────────────────────────────────

export function listCountries() {
  return getCountries().map(c => ({ code: c.code, name: c.name }));
}

/* Note `unit` is omitted deliberately. getIndicatorMeta derives it from the first series seen,
   which for a local-currency level means one arbitrary country's currency — "TT$ mn" on an
   indicator 18 economies report in their own money. Units belong to a series, never to a slug.
   `comparable` carries the part that is a property of the slug: whether cross-country
   comparison is meaningful at all. */
export function listIndicators() {
  const comparable = new Set(getFeaturedIndicators().map(m => m.slug));
  return getIndicatorMeta().map(m => ({
    slug: m.slug,
    label: m.label,
    comparable: comparable.has(m.slug),
    economies: getIndicatorAllCountries(m.slug).map(s => s.country),
  }));
}

function toEvidence(s: IndicatorSeries, yearFrom: number | null, yearTo: number | null): DataEvidence {
  const points = s.series.filter(
    p => (yearFrom === null || p.year >= yearFrom) && (yearTo === null || p.year <= yearTo),
  );
  // The latest vintage across the retrieved window — what a reader would need to reproduce it.
  const vintages = [...new Set(points.map(p => p.vintage))].sort();

  return {
    country: s.country,
    indicator: s.indicator,
    label: s.indicatorLabel,
    unit: s.unit,
    source: s.source,
    sourceOrg: s.sourceOrg,
    sourceTier: s.sourceTier,
    sourceUrl: s.sourceUrl,
    vintage: vintages[vintages.length - 1] ?? '',
    confidence: s.confidence,
    ...(s.seriesNote ? { note: s.seriesNote } : {}),
    points: points.map(p => ({ year: p.year, value: p.value, type: p.type })),
  };
}

/* One country + one indicator, trimmed to the requested years. Returns a miss rather than an
   empty result so the caller can distinguish "the hub lacks this" from "nothing came back". */
export function getSeriesEvidence(
  country: string,
  indicator: string,
  yearFrom: number | null = null,
  yearTo: number | null = null,
): { evidence: DataEvidence | null; miss: RetrievalMiss | null } {
  const series = getSeries(country, indicator);
  if (!series) {
    const available = getIndicatorAllCountries(indicator).map(s => s.country);
    return {
      evidence: null,
      miss: {
        kind: 'series',
        detail: available.length
          ? `The hub has no "${indicator}" series for ${country}. It carries that indicator for: ${available.join(', ')}.`
          : `The hub has no "${indicator}" series at all.`,
      },
    };
  }

  const evidence = toEvidence(series, yearFrom, yearTo);
  if (!evidence.points.length) {
    const years = series.series.map(p => p.year);
    return {
      evidence: null,
      miss: {
        kind: 'years',
        detail: `"${indicator}" for ${country} covers ${Math.min(...years)}–${Math.max(...years)}, which does not include the requested period.`,
      },
    };
  }
  return { evidence, miss: null };
}

/* One indicator across chosen countries — never the whole region unless no countries were
   named, which is what a ranking question looks like once the Interpreter has parsed it. */
export function getSelectedCountrySeries(
  countries: string[],
  indicator: string,
  yearFrom: number | null = null,
  yearTo: number | null = null,
): { evidence: DataEvidence[]; misses: RetrievalMiss[] } {
  const targets = countries.length
    ? countries.slice(0, MAX_COMPARISON_COUNTRIES)
    : getIndicatorAllCountries(indicator).map(s => s.country);

  const evidence: DataEvidence[] = [];
  const misses: RetrievalMiss[] = [];
  for (const country of targets) {
    const result = getSeriesEvidence(country, indicator, yearFrom, yearTo);
    if (result.evidence) evidence.push(result.evidence);
    if (result.miss) misses.push(result.miss);
  }
  return { evidence, misses };
}

export { searchNews, getNewsCoverage };

// ── Router ─────────────────────────────────────────────────────────────────────────────────

/* Turn a validated intent into evidence, with no model in the loop (plan §8). Mode A of the two
   retrieval modes: whatever replaces this — a tool-calling retriever in Phase 3 — must emit this
   same EvidencePackage, so nothing downstream can tell which retriever ran.

   `retrievedAt` is a parameter, not a `new Date()` read inside this function, on purpose: this
   file's whole premise is "no LLM, no network, same inputs to same outputs every time" (see the
   header), and reading the wall clock internally would make buildEvidencePackage the one
   non-deterministic thing in it. The real caller supplies the moment of the actual request;
   tests supply a fixed value and get an exactly reproducible package, evidenceMeta included. */
export function buildEvidencePackage(
  intent: AskIntent,
  retrievedAt: string = new Date().toISOString(),
): EvidencePackage {
  const pkg: EvidencePackage = {
    data: [],
    news: [],
    misses: [],
    caveats: [],
    toolsUsed: [],
    newsCoverage: getNewsCoverage(),
    evidenceMeta: [],
  };

  const wantsData = intent.indicators.length > 0;

  if (intent.questionType === 'comparison' && wantsData) {
    const indicator = intent.indicators[0];
    if (intent.countries.length === 1) {
      pkg.misses.push({
        kind: 'country',
        detail: `A comparison needs at least two economies; only ${intent.countries[0]} resolved.`,
      });
    }
    const { evidence, misses } = getSelectedCountrySeries(
      intent.countries, indicator, intent.yearFrom, intent.yearTo,
    );
    pkg.data.push(...evidence);
    pkg.misses.push(...misses);
    pkg.toolsUsed.push('getSelectedCountrySeries');
  } else if (wantsData) {
    // indicator, or a news question that also names an indicator: one country, its series.
    const countries = intent.countries.length ? [intent.countries[0]] : [];
    if (!countries.length) {
      pkg.misses.push({ kind: 'country', detail: 'No economy in the hub was identified in the question.' });
    }
    for (const country of countries) {
      for (const indicator of intent.indicators.slice(0, MAX_INDICATORS)) {
        const { evidence, miss } = getSeriesEvidence(country, indicator, intent.yearFrom, intent.yearTo);
        if (evidence) pkg.data.push(evidence);
        if (miss) pkg.misses.push(miss);
      }
    }
    pkg.toolsUsed.push('getSeries');
  } else if (intent.questionType !== 'news') {
    pkg.misses.push({ kind: 'indicator', detail: 'No hub indicator was identified in the question.' });
  }

  if (intent.questionType === 'news') {
    /* Temporal alignment (plan §6): a question about a past year must not be answered with
       today's headlines. An explicit year range becomes a hard date window; without one the
       search is unbounded, and the archive is only four months deep anyway. */
    const dateFrom = intent.yearFrom !== null ? `${intent.yearFrom}-01-01` : null;
    const dateTo = intent.yearTo !== null ? `${intent.yearTo}-12-31` : null;

    pkg.news = searchNews({
      countries: intent.countries,
      keywords: intent.newsKeywords,
      dateFrom,
      dateTo,
      limit: MAX_NEWS,
    });
    pkg.toolsUsed.push('searchNews');

    if (!pkg.news.length) {
      const window = dateFrom ? ` between ${dateFrom} and ${dateTo ?? 'today'}` : '';
      pkg.misses.push({
        kind: 'news',
        detail: `No News Hub records match that query${window}. The News Hub covers ${pkg.newsCoverage.earliest} to ${pkg.newsCoverage.latest}.`,
      });
    }
    pkg.caveats.push(
      'News evidence is headline metadata only — title, source, date and link. No article text is stored, so nothing may be reported as read from an article body.',
    );
  }

  addComparabilityCaveats(pkg, intent);

  /* Derived from the final pkg.data/pkg.news rather than accumulated alongside them at each
     push site: every ref this package could possibly carry is decided by then, so one pass here
     is simpler than threading an evidenceMeta.push() through every branch above and cannot drift
     out of sync with what actually ended up in the package. */
  pkg.evidenceMeta = [
    ...pkg.data.map((d): EvidenceMeta => ({
      ref: `D:${evidenceId(d.country, d.indicator)}`,
      vintage: d.vintage,
      retrievedAt,
      sourceRevisionDate: null,
      contentHash: null,
    })),
    ...pkg.news.map((n): EvidenceMeta => ({
      ref: `N:${n.id}`,
      vintage: null, // News has no vintage concept — only D: series revisions carry one.
      retrievedAt,
      sourceRevisionDate: null,
      contentHash: null,
    })),
  ];

  return pkg;
}

/* Local-currency levels are stored in each country's own money, so differencing or ranking them
   across countries produces a real-looking, meaningless number. The unit check catches it from
   the data itself; the slug check catches it even when only one series came back. */
export function addComparabilityCaveats(pkg: EvidencePackage, intent: AskIntent): void {
  if (pkg.data.length < 2) return;

  const units = new Set(pkg.data.map(d => d.unit));
  if (units.size > 1) {
    pkg.caveats.push(
      `Retrieved series use different units (${[...units].join(', ')}). These are local-currency levels: do not difference, sum or rank them across economies. Compare growth rates, ratios or shares instead.`,
    );
  }

  if (intent.questionType === 'comparison') {
    const comparable = new Set(getFeaturedIndicators().map(m => m.slug));
    for (const slug of new Set(pkg.data.map(d => d.indicator))) {
      if (!comparable.has(slug)) {
        pkg.caveats.push(
          `"${slug}" is not a cross-country comparable indicator in the hub; treat any comparison of it as indicative only.`,
        );
      }
    }
  }
}
