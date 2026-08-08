/* global CustomFunctions, fetch */

/* Gate 1 — v1 read-only functions, all backed by /api/indicator (see api/indicator.ts).
   Deterministic lookups only; no LLM in this path.

   The API host is injected at build time by webpack's DefinePlugin (see webpack.config.js),
   never hardcoded here — so switching environments is a build flag, not a source edit, and
   a build can't accidentally ship a localhost or throwaway-deployment URL. Override with:
     CARIBECON_API_BASE=https://my-preview.vercel.app npm run build:dev
   Note: only *.vercel.app preview URLs sit behind this project's Vercel SSO wall, which
   Excel's fetch() cannot pass; the custom domain is exempt, which is why the default is
   caribecon.org. */
const API_BASE = process.env.CARIBECON_API_BASE;

async function lookup(country, indicator, year) {
  const url = `${API_BASE}/api/indicator?country=${encodeURIComponent(country)}&indicator=${encodeURIComponent(indicator)}&year=${year}`;

  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, 'CaribEcon API unreachable.');
  }

  if (res.status === 400) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.invalidValue, 'Bad country, indicator, or year.');
  }
  if (!res.ok) {
    throw new CustomFunctions.Error(CustomFunctions.ErrorCode.notAvailable, 'No sourced value for that lookup.');
  }

  const data = await res.json();
  return data.value;
}

/**
 * Nominal GDP for a Caribbean economy in a given year, sourced from the CaribEcon hub.
 * @customfunction GDP
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {Promise<number>} Nominal GDP, in the source's local-currency units (see the hub for unit/vintage).
 */
export async function gdp(country, year) {
  return lookup(country, 'nominal_gdp', year);
}

/**
 * GDP growth rate (%) for a Caribbean economy in a given year, sourced from the CaribEcon hub.
 * @customfunction GDPGROWTH
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {Promise<number>} GDP growth rate, percent.
 */
export async function gdpGrowth(country, year) {
  return lookup(country, 'gdp_growth', year);
}

/**
 * Any stored CaribEcon indicator, by slug, for a Caribbean economy in a given year.
 * Returns stored values only — no forecasting, no cross-record calculation.
 * @customfunction INDICATOR
 * @param {string} country ISO-ish 2-letter code, e.g. "GY".
 * @param {string} indicatorSlug CaribEcon indicator slug, e.g. "inflation".
 * @param {number} year Calendar year, e.g. 2024.
 * @returns {Promise<number>} The indicator's stored value.
 */
export async function indicator(country, indicatorSlug, year) {
  return lookup(country, indicatorSlug, year);
}
