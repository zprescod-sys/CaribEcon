// Refresh the comparable macro spine in data/almanac-data.json from the live
// World Bank WDI + IMF WEO DataMapper APIs. Every `sourceTier: "comparable"` series is
// re-pulled in full and overwritten with the most-recent vintage; `sourceTier: "primary"`
// records (hand-keyed national sources) are left completely untouched.
//
// Safety rules (see data/SCHEMA.md):
//   - Primary records are never modified.
//   - A source that returns nothing keeps the existing series (never wipe to empty).
//   - Never mix source families within a series — each record is refreshed only from the
//     API family named in its own `sourceOrg`.
//   - The year frontier is dynamic: WB stays at its actual frontier; IMF adds projection
//     years up to the current calendar year.
//
// Run: npm run data:refresh   (part of .github/workflows/data.yml)
import fs from 'fs';
import {
  ISO3, WB, IMF_CODE, rnd, prefetchIMF, prefetchWB, imfType, imfVintage,
} from './lib/sources.mjs';

const FILE = './data/almanac-data.json';
const START_YEAR = 2015;
const END_YEAR = new Date().getFullYear();   // advance the frontier as sources publish
const IMF_VINTAGE = imfVintage();
const ISO_LIST = Object.values(ISO3);

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Prefetch every source once: IMF WEO (all countries per code) and World Bank (all 19
// countries per code, one call per indicator — the WB API is slow, so batching matters).
const IMF = await prefetchIMF(Object.values(IMF_CODE));
const WB_DATA = await prefetchWB([...new Set(Object.values(WB).map((w) => w.code))], ISO_LIST, START_YEAR, END_YEAR);
const wb = (iso, code) => WB_DATA[code]?.[iso] || { byYear: {}, vintage: '' };

// Refreshed nominal GDP (WB, in <local> mn) per iso — needed to derive IMF fiscal_balance.
const nominalCache = {};
function nominalByYear(iso) {
  if (nominalCache[iso]) return nominalCache[iso];
  const { byYear } = wb(iso, WB.nominal_gdp.code);
  const m = {};
  for (const y of Object.keys(byYear)) m[+y] = rnd(byYear[y] / WB.nominal_gdp.div, WB.nominal_gdp.round);
  nominalCache[iso] = m;
  return m;
}

const inRange = (y) => y >= START_YEAR && y <= END_YEAR;

// Build the refreshed series for one comparable record, or null if this
// (sourceOrg, indicator) pair has no mapping (caller logs it — never silently skipped).
function refreshSeries(rec) {
  const ind = rec.indicator;
  const iso = ISO3[rec.country];
  if (!iso) return null;

  if (rec.sourceOrg === 'World Bank WDI' && WB[ind]) {
    const { code, div, round } = WB[ind];
    const { byYear, vintage } = wb(iso, code);
    return Object.keys(byYear).map(Number).filter(inRange).sort((a, b) => a - b)
      .map((y) => ({ year: y, value: rnd(byYear[y] / div, round), type: 'actual', vintage: vintage || IMF_VINTAGE }))
      .filter((p) => p.value != null);
  }

  if (rec.sourceOrg === 'IMF WEO' && IMF_CODE[ind]) {
    const vals = IMF[IMF_CODE[ind]][iso] || {};
    const years = Object.keys(vals).map(Number).filter(inRange).sort((a, b) => a - b);

    if (ind === 'current_account') {          // BCA is US$ bn -> stored US$ mn
      return years.map((y) => ({ year: y, value: rnd(vals[y] * 1000, 0), type: imfType(y, END_YEAR), vintage: IMF_VINTAGE }))
        .filter((p) => p.value != null);
    }
    if (ind === 'fiscal_balance') {           // derived: GGXCNL_NGDP% × nominal GDP ÷ 100
      const nom = nominalByYear(iso);
      return years.filter((y) => nom[y] != null)
        .map((y) => ({ year: y, value: rnd(vals[y] * nom[y] / 100, 1), type: 'derived', vintage: IMF_VINTAGE }))
        .filter((p) => p.value != null);
    }
    // growth / inflation / debt%  (direct, kept in source units)
    const round = ind === 'gross_govt_debt_pct_gdp' ? 1 : 2;
    return years.map((y) => ({ year: y, value: rnd(vals[y], round), type: imfType(y, END_YEAR), vintage: IMF_VINTAGE }))
      .filter((p) => p.value != null);
  }

  return null; // unmapped comparable pair
}

let refreshed = 0, valuesChanged = 0, keptEmpty = 0;
const unmapped = [];

for (const rec of data) {
  if (rec.sourceTier !== 'comparable') continue;   // primary records untouched
  const series = refreshSeries(rec);
  if (series === null) { unmapped.push(`${rec.country}|${rec.indicator} (${rec.sourceOrg})`); continue; }
  if (!series.length) { keptEmpty++; continue; }    // source empty -> keep existing series

  const old = new Map(rec.series.map((p) => [p.year, p.value]));
  for (const p of series) if (old.get(p.year) !== p.value) valuesChanged++;
  rec.series = series;
  refreshed++;
}

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');

console.log(`[refresh-data] frontier ${START_YEAR}-${END_YEAR}, IMF vintage ${IMF_VINTAGE}`);
console.log(`  comparable series refreshed: ${refreshed}`);
console.log(`  individual values changed:   ${valuesChanged}`);
console.log(`  kept (source returned empty): ${keptEmpty}`);
if (unmapped.length) {
  console.log(`  UNMAPPED comparable records (left as-is, need a code mapping):`);
  for (const u of unmapped) console.log(`    - ${u}`);
}
