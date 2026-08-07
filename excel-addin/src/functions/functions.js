/* global CustomFunctions, fetch */

/* Gate 1 — v1 read-only functions, all backed by /api/indicator (see api/indicator.ts).
   Deterministic lookups only; no LLM in this path.

   Points at the isolated caribecon-gate1-proof deployment rather than this branch's own
   preview URL: the economic-dashboard Vercel project has SSO/Vercel Authentication enabled
   for everything except its custom domain (deploymentType: "all_except_custom_domains"), so
   *.vercel.app preview URLs redirect to a Vercel login wall before this code ever runs —
   Excel's fetch() has no Vercel session, so that redirect would break it. Production on the
   custom domain (caribecon.org) is exempt, so once this branch is merged, switch this to
   https://caribecon.org/api/indicator — no bypass token, no protection-setting changes. */
const API_BASE = 'https://caribecon-gate1-proof.vercel.app';

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
