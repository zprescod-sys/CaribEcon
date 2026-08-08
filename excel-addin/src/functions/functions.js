/* global CustomFunctions, fetch */

/* Gate 1 — read-only functions over the CaribEcon hub. Deterministic lookups only; no LLM
   in this path.

   ── Why nothing here is `async` ──────────────────────────────────────────────────────────
   Excel renders #BUSY! in a cell for exactly as long as a custom function's returned Promise
   is pending. An `async` function ALWAYS returns a Promise, so even an instant cache hit
   flashes #BUSY!. These functions are therefore plain functions that return EITHER a value
   (synchronous — Excel writes it straight to the cell, no #BUSY! ever) OR a Promise (only
   while the snapshot is still loading, or on the degraded fallback path).

   The whole hub is 2,742 points across 284 series and compresses to ~20KB, so it is fetched
   once from /api/snapshot at module evaluation — which, thanks to the shared runtime declared
   in manifest.xml, happens when the workbook opens, long before anyone finishes typing a
   formula. After that every lookup is an in-memory Map hit. A 20x10 grid costs one request
   instead of 200.

   If /api/snapshot is unreachable we fall back to the original per-call /api/indicator
   lookups, so the worst case is exactly the old behaviour rather than a broken add-in.

   The API host is injected at build time by webpack's DefinePlugin (see webpack.config.js),
   never hardcoded here — so switching environments is a build flag, not a source edit, and
   a build can't accidentally ship a localhost or throwaway-deployment URL. Override with:
     CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
   Note: only *.vercel.app preview URLs sit behind this project's Vercel SSO wall, which
   Excel's fetch() cannot pass; the custom domain is exempt, which is why the default is
   caribecon.org. */

import {
  loadHub,
  hub,
  hubFailed,
  findPoint,
  findSeries,
  pointsInRange,
  normCountry,
  normSlug,
  P_YEAR,
  P_VALUE,
  P_VINTAGE,
} from '../shared/hub.js';

const API_BASE = process.env.CARIBECON_API_BASE;

// Kicks off at module evaluation = runtime start = workbook open.
const ready = loadHub(API_BASE);

// ── Argument validation ────────────────────────────────────────────────────────────────────

function requireCountry(country) {
  const c = normCountry(country);
  if (!c) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'Country code is required, e.g. "GY".');
  }
  return c;
}

function requireSlug(slug) {
  const s = normSlug(slug);
  if (!s) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'Indicator slug is required, e.g. "inflation".');
  }
  return s;
}

function requireYear(year) {
  const n = Number(year);
  if (!Number.isInteger(n)) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'Year must be a whole number, e.g. 2024.');
  }
  return n;
}

function notAvailable(message) {
  return new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, message);
}

// ── The sync/async split, in one place ─────────────────────────────────────────────────────

/* `read` runs against the loaded snapshot; `fallback` returns a Promise via the per-lookup API.
   Returning read()'s value directly — not a resolved Promise — is what keeps #BUSY! off the
   screen. */
function withHub(read, fallback) {
  const h = hub();
  if (h) return read(h);
  if (hubFailed()) return fallback();
  return ready.then(() => {
    const loaded = hub();
    return loaded ? read(loaded) : fallback();
  });
}

// Resolves one point or raises the Excel-facing error explaining which part of it missed.
function point(h, country, slug, year) {
  const found = findPoint(h, country, slug, year);
  if (found) return found;
  if (!findSeries(h, country, slug)) {
    throw notAvailable(`No ${slug} series for ${country} in the CaribEcon hub.`);
  }
  throw notAvailable(`No sourced value for ${country}/${slug}/${year}.`);
}

// ── Fallback path: one /api/indicator call per lookup (pre-snapshot behaviour) ──────────────

async function fetchPoint(country, slug, year) {
  const url = `${API_BASE}/api/indicator?country=${encodeURIComponent(country)}&indicator=${encodeURIComponent(slug)}&year=${year}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw notAvailable('CaribEcon API unreachable.');
  }

  if (res.status === 400) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'Bad country, indicator, or year.');
  }
  if (!res.ok) {
    throw notAvailable(`No sourced value for ${country}/${slug}/${year}.`);
  }

  return res.json();
}

function fetchField(country, slug, year, field) {
  return fetchPoint(country, slug, year).then(data => data[field]);
}

// Reads one field of a resolved lookup, snapshot-first with the API as fallback.
function field(country, slug, year, readSnapshot, apiField) {
  const c = requireCountry(country);
  const s = requireSlug(slug);
  const y = requireYear(year);
  return withHub(
    h => readSnapshot(point(h, c, s, y)),
    () => fetchField(c, s, y, apiField),
  );
}

// ── Value functions ────────────────────────────────────────────────────────────────────────

/**
 * Nominal GDP for a Caribbean economy in a given year, sourced from the CaribEcon hub.
 * @customfunction GDP
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {number} Nominal GDP, in the source's local-currency units (see CE.UNIT).
 */
export function gdp(country, year) {
  return field(country, 'nominal_gdp', year, f => f.point[P_VALUE], 'value');
}

/**
 * GDP growth rate (%) for a Caribbean economy in a given year, sourced from the CaribEcon hub.
 * @customfunction GDPGROWTH
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {number} GDP growth rate, percent.
 */
export function gdpGrowth(country, year) {
  return field(country, 'gdp_growth', year, f => f.point[P_VALUE], 'value');
}

/**
 * Any stored CaribEcon indicator, by slug, for a Caribbean economy in a given year.
 * Returns stored values only — no forecasting, no cross-record calculation.
 * @customfunction INDICATOR
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "inflation".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {number} The indicator's stored value.
 */
export function indicator(country, indicatorSlug, year) {
  return field(country, indicatorSlug, year, f => f.point[P_VALUE], 'value');
}

/**
 * A whole time series for one country and indicator, spilled as two columns: year, value.
 * Years with no sourced value are omitted rather than returned as zero.
 * @customfunction SERIES
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "gdp_growth".
 * @param {number} [startYear] First year to include. Omit for the earliest available.
 * @param {number} [endYear] Last year to include. Omit for the latest available.
 * @returns {number[][]} Two columns — year and value — one row per sourced year.
 */
export function series(country, indicatorSlug, startYear, endYear) {
  const c = requireCountry(country);
  const s = requireSlug(indicatorSlug);
  const from = startYear === null || startYear === undefined ? -Infinity : requireYear(startYear);
  const to = endYear === null || endYear === undefined ? Infinity : requireYear(endYear);

  if (from > to) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'startYear must not be after endYear.');
  }

  return withHub(
    h => {
      const found = findSeries(h, c, s);
      if (!found) {
        throw notAvailable(`No ${s} series for ${c} in the CaribEcon hub.`);
      }
      const rows = pointsInRange(found, from, to).map(p => [p[P_YEAR], p[P_VALUE]]);
      if (!rows.length) {
        throw notAvailable(`No sourced ${s} values for ${c} in that year range.`);
      }
      return rows;
    },
    () => fetchSeriesFallback(c, s, from, to),
  );
}

/* Degraded path only: without the snapshot there is no bulk endpoint, so probe the range one
   year at a time. Bounded to the hub's actual coverage (2015 onward) so an omitted startYear
   can't turn into an unbounded scan. */
async function fetchSeriesFallback(country, slug, from, to) {
  const thisYear = new Date().getFullYear();
  const first = Math.max(from === -Infinity ? 2015 : from, 2015);
  const last = Math.min(to === Infinity ? thisYear : to, thisYear);

  const years = [];
  for (let y = first; y <= last; y++) years.push(y);

  const results = await Promise.all(
    years.map(y => fetchPoint(country, slug, y).then(d => [y, d.value]).catch(() => null)),
  );

  const rows = results.filter(Boolean);
  if (!rows.length) {
    throw notAvailable(`No sourced ${slug} values for ${country} in that year range.`);
  }
  return rows;
}

// ── Provenance functions ───────────────────────────────────────────────────────────────────
// Every number in this hub carries its source and vintage; these make that visible in the
// sheet instead of stopping at the cell boundary.

/**
 * The citation for a stored CaribEcon value — the dataset and series it came from.
 * @customfunction SOURCE
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "nominal_gdp".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {string} Source citation, e.g. "World Bank — World Development Indicators".
 */
export function source(country, indicatorSlug, year) {
  return field(country, indicatorSlug, year, f => f.series.src, 'source');
}

/**
 * The data vintage for a stored CaribEcon value — which release the figure was taken from.
 * @customfunction VINTAGE
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "nominal_gdp".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {string} Vintage, e.g. "2026-07".
 */
export function vintage(country, indicatorSlug, year) {
  return field(country, indicatorSlug, year, f => f.point[P_VINTAGE], 'vintage');
}

/**
 * The unit a stored CaribEcon value is expressed in. Local-currency levels differ by country,
 * so this is not safe to assume from the indicator alone.
 * @customfunction UNIT
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "nominal_gdp".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {string} Unit, e.g. "GY$ mn" or "%".
 */
export function unit(country, indicatorSlug, year) {
  return field(country, indicatorSlug, year, f => f.series.u, 'unit');
}
