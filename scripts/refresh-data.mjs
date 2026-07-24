// Refresh the comparable macro spine in data/almanac-data.json from the live
// World Bank WDI API. Every World-Bank-sourced `sourceTier: "comparable"` series is
// re-pulled in full and overwritten with the most-recent vintage; `sourceTier: "primary"`
// records (hand-keyed national sources) are left completely untouched.
//
// World-Bank-only by design: the IMF DataMapper API blocks datacenter/CI IPs behind a
// bot-WAF (403 / dropped connections) and the IMF prohibits bulk automated download
// without permission. Records still tagged `sourceOrg: "IMF WEO"` — general-government
// debt, fiscal balance, current account, and four inflation series the WB does not cover
// cleanly — are HELD: skipped here and hand-maintained from the April/October WEO
// releases. Their `series` are never touched by this script.
//
// Safety rules (see data/SCHEMA.md):
//   - Primary records are never modified.
//   - IMF-held records are never modified.
//   - A source that returns nothing keeps the existing series (never wipe to empty).
//   - Never mix source families within a series — each record is refreshed only from the
//     API family named in its own `sourceOrg`.
//   - The year frontier is dynamic: WB stays at its own actual frontier.
//
// Run: npm run data:refresh   (part of .github/workflows/data.yml)
import fs from 'fs';
import { ISO3, WB, rnd, prefetchWB } from './lib/sources.mjs';

const FILE = './data/almanac-data.json';
const START_YEAR = 2015;
const END_YEAR = new Date().getFullYear();   // advance the frontier as sources publish
const ISO_LIST = Object.values(ISO3);

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// Fallback vintage (YYYY-MM of this run) for the rare case where the WB API returns rows
// but no `lastupdated` in its metadata — `vintage` must never be written empty (schema).
const RUN_VINTAGE = new Date().toISOString().slice(0, 7);

// Prefetch the World Bank once: all 19 countries per code, one call per indicator —
// the WB API is slow, so batching matters.
const WB_DATA = await prefetchWB([...new Set(Object.values(WB).map((w) => w.code))], ISO_LIST, START_YEAR, END_YEAR);
const wb = (iso, code) => WB_DATA[code]?.[iso] || { byYear: {}, vintage: '' };

const inRange = (y) => y >= START_YEAR && y <= END_YEAR;

// Build the refreshed series for one World-Bank-sourced comparable record, or null if
// this indicator has no WB mapping (caller logs it — never silently skipped).
function refreshSeries(rec) {
  const ind = rec.indicator;
  const iso = ISO3[rec.country];
  if (!iso || !WB[ind]) return null;

  const { code, div, round } = WB[ind];
  const { byYear, vintage } = wb(iso, code);
  return Object.keys(byYear).map(Number).filter(inRange).sort((a, b) => a - b)
    .map((y) => ({ year: y, value: rnd(byYear[y] / div, round), type: 'actual', vintage: vintage || RUN_VINTAGE }))
    .filter((p) => p.value != null);
}

let refreshed = 0, valuesChanged = 0, keptEmpty = 0, held = 0;
const unmapped = [];

for (const rec of data) {
  if (rec.sourceTier !== 'comparable') continue;   // primary records untouched
  // IMF-sourced records are hand-maintained (see header) — never fetched, never rewritten.
  if (rec.sourceOrg === 'IMF WEO') { held++; continue; }

  const series = refreshSeries(rec);
  if (series === null) { unmapped.push(`${rec.country}|${rec.indicator} (${rec.sourceOrg})`); continue; }
  if (!series.length) { keptEmpty++; continue; }    // source empty -> keep existing series

  const old = new Map(rec.series.map((p) => [p.year, p.value]));
  for (const p of series) if (old.get(p.year) !== p.value) valuesChanged++;
  rec.series = series;
  refreshed++;
}

fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');

console.log(`[refresh-data] World Bank WDI only, frontier ${START_YEAR}-${END_YEAR}`);
console.log(`  comparable series refreshed:  ${refreshed}`);
console.log(`  individual values changed:    ${valuesChanged}`);
console.log(`  kept (source returned empty): ${keptEmpty}`);
console.log(`  held (IMF WEO — hand-maintained): ${held}`);
if (unmapped.length) {
  console.log(`  UNMAPPED comparable records (left as-is, need a code mapping):`);
  for (const u of unmapped) console.log(`    - ${u}`);
}
