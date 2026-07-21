// Shared comparable-source maps and fetch helpers for the macro-data pipeline.
// Both scripts/refresh-data.mjs (re-pulls the comparable spine) and
// scripts/check-primary-drift.mjs (cross-checks hand-keyed primary records) import
// from here, so the World Bank / IMF codes, units, and country mapping can never drift
// between the two — the same single-source-of-truth idea as src/lib/newsRelevance.mjs.

// 2-letter dashboard code -> ISO3 (19 economies; HT/AW/CW added 2026-07).
export const ISO3 = {
  TT: 'TTO', GY: 'GUY', BB: 'BRB', JM: 'JAM', BS: 'BHS', KY: 'CYM', BZ: 'BLZ',
  SR: 'SUR', GD: 'GRD', LC: 'LCA', AG: 'ATG', KN: 'KNA', DM: 'DMA', VC: 'VCT',
  TC: 'TCA', VG: 'VGB', HT: 'HTI', AW: 'ABW', CW: 'CUW',
};

// World Bank WDI indicators -> { code, div (raw->stored unit), round (decimals) }.
// `div` converts the raw WB value into the unit stored in almanac-data.json
// (e.g. NY.GDP.MKTP.CN is current LCU; /1e6 -> "<local> mn").
export const WB = {
  nominal_gdp:          { code: 'NY.GDP.MKTP.CN',    div: 1e6, round: 1 },
  real_gdp:             { code: 'NY.GDP.MKTP.KN',    div: 1e6, round: 1 },
  gdp_growth:           { code: 'NY.GDP.MKTP.KD.ZG', div: 1,   round: 2 },
  gdp_per_capita:       { code: 'NY.GDP.PCAP.CN',    div: 1,   round: 0 },
  population:           { code: 'SP.POP.TOTL',       div: 1,   round: 0 },
  inflation:            { code: 'FP.CPI.TOTL.ZG',    div: 1,   round: 2 },
  fx_rate_usd:          { code: 'PA.NUS.FCRF',       div: 1,   round: 4 },
  unemployment:         { code: 'SL.UEM.TOTL.ZS',    div: 1,   round: 2 },
  labour_participation: { code: 'SL.TLF.CACT.ZS',    div: 1,   round: 2 },
  dependency_ratio:     { code: 'SP.POP.DPND',       div: 1,   round: 2 },
  fdi:                  { code: 'BX.KLT.DINV.CD.WD',  div: 1e6, round: 1 },
};

// IMF WEO DataMapper indicators -> series code. current_account (BCA) is US$ bn,
// stored as US$ mn (×1000). fiscal_balance is derived (GGXCNL_NGDP% × nominal GDP ÷ 100).
export const IMF_CODE = {
  gdp_growth: 'NGDP_RPCH', inflation: 'PCPIPCH', gross_govt_debt_pct_gdp: 'GGXWDG_NGDP',
  current_account: 'BCA', fiscal_balance: 'GGXCNL_NGDP',
};

// Round to `d` decimals; pass null/NaN straight through as null.
export const rnd = (v, d) =>
  v == null || Number.isNaN(v) ? null : (d === 0 ? Math.round(v) : Math.round(v * 10 ** d) / 10 ** d);

// "2026-04-08" -> "2026-04" (the YYYY-MM vintage stored per point).
export const ym = (s) => (s ? String(s).slice(0, 7) : '');

// fetch JSON with linear backoff and a per-attempt timeout (so a stalled endpoint can
// never hang the run — important in CI). Throws only after all retries fail so a caller
// can decide to keep existing data rather than crash.
export async function getJSON(url, tries = 4, timeoutMs = 45000) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'caribecon-data-refresh' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return await r.json();
    } catch { /* timeout or network error -> retry */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error('fetch failed: ' + url);
}

// Prefetch a set of IMF WEO series once (each call returns all countries keyed by ISO3).
// Returns { CODE: { ISO3: { "2015": value, ... } } }. A code that fails after all retries
// is logged and returned empty rather than crashing the run (callers keep existing data).
export async function prefetchIMF(codes) {
  const out = {};
  for (const code of codes) {
    try {
      const j = await getJSON(`https://www.imf.org/external/datamapper/api/v1/${code}`);
      out[code] = j.values?.[code] || {};
    } catch (e) {
      console.warn(`  ✗ IMF ${code} failed (${e.message}) — keeping existing data for it`);
      out[code] = {};
    }
  }
  return out;
}

// Fetch one World Bank series for MANY countries in a single call — the WB API is slow and
// rate-limits parallel requests, so batching all 19 ISO3s per indicator (one call instead
// of nineteen) is dramatically faster and gentler. Returns { ISO3: { byYear, vintage } }.
// Values are raw (not divided) — the caller applies WB[ind].div / round.
export async function wbFetchMulti(iso3List, code, startYear, endYear) {
  const j = await getJSON(
    `https://api.worldbank.org/v2/country/${iso3List.join(';')}/indicator/${code}?format=json&date=${startYear}:${endYear}&per_page=500`,
  );
  const meta = Array.isArray(j) ? j[0] : null;
  const rows = Array.isArray(j) ? j[1] : null;
  const vintage = ym(meta?.lastupdated);
  const out = {};
  for (const iso of iso3List) out[iso] = { byYear: {}, vintage };
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const iso = r.countryiso3code;
      if (r.value != null && out[iso]) out[iso].byYear[+r.date] = r.value;
    }
  }
  return out;
}

// Prefetch a set of World Bank codes for all given countries -> { CODE: { ISO3: {byYear,vintage} } }.
// Sequential + paced on purpose: the WB API is slow and throttles bursts, so concurrency
// hurts. A short gap between calls keeps us under its rate limit.
export async function prefetchWB(codes, iso3List, startYear, endYear, spacingMs = 1000) {
  const out = {};
  for (const code of codes) {
    try {
      out[code] = await wbFetchMulti(iso3List, code, startYear, endYear);
    } catch (e) {
      console.warn(`  ✗ World Bank ${code} failed (${e.message}) — keeping existing data for it`);
      out[code] = {}; // empty -> callers keep the existing series (never wipe)
    }
    if (spacingMs) await new Promise((r) => setTimeout(r, spacingMs));
  }
  return out;
}

// IMF WEO point type by year, relative to the frontier. WEO's April cycle publishes the
// last full year as `actual` two years back, the prior year as `estimate`, and the current
// year onward as `projection`. The DataMapper API does not expose `estimatesStartAfter`,
// so this is a documented heuristic (see data/SCHEMA.md).
export function imfType(year, endYear) {
  if (year <= endYear - 2) return 'actual';
  if (year === endYear - 1) return 'estimate';
  return 'projection';
}

// Map a run date to the IMF WEO release vintage it is most likely serving.
// WEO releases in April and October; heuristic (see data/SCHEMA.md).
export function imfVintage(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  if (m >= 4 && m <= 9) return `${y}-04`;
  if (m >= 10) return `${y}-10`;
  return `${y - 1}-10`; // Jan-Mar -> previous October release
}
