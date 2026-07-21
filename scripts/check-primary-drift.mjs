// Cross-check hand-keyed PRIMARY records against the live World Bank / IMF comparable
// series and report where they have drifted apart — WITHOUT changing any value.
// National sources (MoF / central-bank PDFs) have no API, so they can't be auto-refreshed;
// this flags the ones worth re-checking by hand and writes a report the weekly PR carries.
//
// Only indicators with a direct comparable equivalent are checked. Derived comparables
// (fiscal_balance) and primary-only series (revenue/expenditure breakdowns, monetary_base,
// import_cover, capital_account, gross/net debt levels, primary_balance) have no clean
// cross-reference and are listed as "not cross-checkable" rather than falsely flagged.
//
// Run: npm run data:drift   (part of .github/workflows/data.yml)
import fs from 'fs';
import { ISO3, WB, rnd, prefetchIMF, prefetchWB } from './lib/sources.mjs';

const FILE = './data/almanac-data.json';
const MD_OUT = './audit/primary-drift.md';
const JSON_OUT = './audit/primary-drift.json';
const START_YEAR = 2015;
const END_YEAR = new Date().getFullYear();

// Drift thresholds (tunable): percentage-unit indicators compared in absolute points,
// everything else in relative %. Near-zero levels fall back to an absolute floor so a
// tiny denominator can't manufacture a huge relative gap.
const PP_THRESHOLD = 1.0;    // percentage points, for unit === '%'
const REL_THRESHOLD = 0.05;  // 5% relative, for level indicators
const NEAR_ZERO = 50;        // |value| below this uses an absolute fallback (in stored unit)

// Indicators we can fetch directly and compare 1:1 against a stored primary value.
const IMF_DIRECT = { gross_govt_debt_pct_gdp: 'GGXWDG_NGDP', current_account: 'BCA' };
const NO_CROSS_REF = new Set([
  'fiscal_balance', 'primary_balance', 'gross_govt_debt', 'net_govt_debt', 'capital_account',
  'monetary_base', 'import_cover', 'govt_revenue_total', 'govt_current_expenditure',
  'govt_capital_expenditure', 'govt_total_expenditure',
]);

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const primary = data.filter((r) => r.sourceTier === 'primary');
const ISO_LIST = Object.values(ISO3);

// Prefetch only what the cross-check needs: the IMF direct codes, and the WB codes for
// whichever cross-checkable indicators actually appear among the primary records.
const IMF = await prefetchIMF([...new Set(Object.values(IMF_DIRECT))]);
const wbCodesNeeded = [...new Set(primary.filter((r) => WB[r.indicator]).map((r) => WB[r.indicator].code))];
const WB_DATA = await prefetchWB(wbCodesNeeded, ISO_LIST, START_YEAR, END_YEAR);

// Return the comparable series for a primary record as { year: value } in stored units,
// or null if the indicator has no direct cross-reference.
function comparableByYear(rec) {
  const iso = ISO3[rec.country];
  const ind = rec.indicator;
  if (!iso) return null;

  if (WB[ind]) {
    const { code, div, round } = WB[ind];
    const byYear = WB_DATA[code]?.[iso]?.byYear || {};
    const out = {};
    for (const y of Object.keys(byYear)) out[+y] = rnd(byYear[y] / div, round);
    return out;
  }
  if (IMF_DIRECT[ind]) {
    const vals = IMF[IMF_DIRECT[ind]][iso] || {};
    const scale = ind === 'current_account' ? 1000 : 1;   // BCA US$ bn -> US$ mn
    const round = ind === 'current_account' ? 0 : 1;
    const out = {};
    for (const y of Object.keys(vals)) if (+y >= START_YEAR && +y <= END_YEAR) out[+y] = rnd(vals[y] * scale, round);
    return out;
  }
  return null;
}

// Decide whether a stored vs comparable pair has drifted, and describe the gap.
function assess(unit, stored, comp) {
  if (stored == null || comp == null) return null;
  const delta = stored - comp;
  if (unit === '%') {
    return Math.abs(delta) > PP_THRESHOLD ? { delta, kind: 'pp' } : null;
  }
  const denom = Math.max(Math.abs(comp), NEAR_ZERO);
  const rel = Math.abs(delta) / denom;
  return rel > REL_THRESHOLD ? { delta, kind: 'rel', rel } : null;
}

const flagged = [];      // records with at least one drifting year
const checked = [];      // records actually cross-checked (drift or clean)
const notCrossRef = [];  // primary records with no comparable equivalent
const skipped = [];      // cross-checkable, but the comparable source returned no overlapping data this run

for (const rec of primary) {
  if (NO_CROSS_REF.has(rec.indicator) || (!WB[rec.indicator] && !IMF_DIRECT[rec.indicator])) {
    notCrossRef.push(`${rec.country} · ${rec.indicator}`);
    continue;
  }
  const comp = comparableByYear(rec);
  if (!comp) { notCrossRef.push(`${rec.country} · ${rec.indicator}`); continue; }

  const years = [];
  let overlapped = 0;
  for (const p of rec.series) {
    if (p.value == null) continue;
    const c = comp[p.year];
    if (c == null) continue;
    overlapped++;
    const hit = assess(rec.unit, p.value, c);
    if (hit) years.push({ year: p.year, stored: p.value, comparable: c, ...hit });
  }
  // No overlapping years means the comparable source gave us nothing to compare against
  // (e.g. a fetch that failed/was rate-limited) — report it as skipped, never as "clean".
  if (overlapped === 0) { skipped.push(`${rec.country} · ${rec.indicator}`); continue; }
  checked.push(`${rec.country} · ${rec.indicator}`);
  if (years.length) {
    flagged.push({
      country: rec.country, indicator: rec.indicator, unit: rec.unit,
      source: rec.source, sourceUrl: rec.sourceUrl, years,
    });
  }
}

// ---- write machine report (generatedAt is stamped by the workflow, kept out here so the
// file diff reflects data drift only, not the clock) ----
const jsonReport = {
  frontier: `${START_YEAR}-${END_YEAR}`,
  thresholds: { ppThreshold: PP_THRESHOLD, relThreshold: REL_THRESHOLD, nearZero: NEAR_ZERO },
  summary: { primaryRecords: primary.length, crossChecked: checked.length, flagged: flagged.length, notCrossCheckable: notCrossRef.length, skipped: skipped.length },
  flagged,
  skipped: skipped.sort(),
  notCrossCheckable: notCrossRef.sort(),
};
fs.mkdirSync('./audit', { recursive: true });
fs.writeFileSync(JSON_OUT, JSON.stringify(jsonReport, null, 2) + '\n');

// ---- write human report ----
const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(v));
const lines = [];
lines.push('# Primary-source drift report');
lines.push('');
lines.push(`Cross-checks hand-keyed **primary** records against live World Bank / IMF data (frontier ${START_YEAR}–${END_YEAR}).`);
lines.push('These values are **not** changed automatically — this is a to-do list of national figures worth re-checking by hand.');
lines.push('');
lines.push(`- Primary records: **${primary.length}** · cross-checked: **${checked.length}** · **flagged: ${flagged.length}** · not cross-checkable: ${notCrossRef.length}${skipped.length ? ` · skipped (source unavailable): ${skipped.length}` : ''}`);
lines.push(`- Thresholds: >${PP_THRESHOLD}pp for %-unit indicators, >${REL_THRESHOLD * 100}% relative for levels.`);
lines.push('');

if (!flagged.length) {
  lines.push('✅ **No primary records drifted beyond threshold.**');
} else {
  lines.push('## ⚠ Flagged — primary value diverges from World Bank / IMF');
  lines.push('');
  for (const f of flagged) {
    lines.push(`### ${f.country} · ${f.indicator} (${f.unit})`);
    lines.push(`Source: ${f.source}${f.sourceUrl ? ` — ${f.sourceUrl}` : ''}`);
    lines.push('');
    lines.push('| Year | Stored (primary) | Comparable (WB/IMF) | Δ |');
    lines.push('| ---- | ---- | ---- | ---- |');
    for (const y of f.years) {
      const d = y.kind === 'pp' ? `${y.delta > 0 ? '+' : ''}${rnd(y.delta, 2)} pp` : `${y.delta > 0 ? '+' : ''}${fmt(rnd(y.delta, 1))} (${rnd(y.rel * 100, 1)}%)`;
      lines.push(`| ${y.year} | ${fmt(y.stored)} | ${fmt(y.comparable)} | ${d} |`);
    }
    lines.push('');
  }
}

if (skipped.length) {
  lines.push('## Skipped this run (comparable source unavailable)');
  lines.push('');
  lines.push('The World Bank / IMF series for these could not be fetched this run (e.g. a rate-limited or failed request), so they were **not** checked — not confirmed clean. They will be re-checked next run:');
  lines.push('');
  lines.push(skipped.map((s) => `- ${s}`).join('\n'));
  lines.push('');
}

if (notCrossRef.length) {
  lines.push('## Not cross-checkable (no comparable equivalent)');
  lines.push('');
  lines.push('These primary series have no clean World Bank / IMF counterpart, so they can only be verified against the national source manually:');
  lines.push('');
  lines.push(notCrossRef.map((s) => `- ${s}`).join('\n'));
  lines.push('');
}

fs.writeFileSync(MD_OUT, lines.join('\n') + '\n');

console.log(`[check-primary-drift] primary ${primary.length} | cross-checked ${checked.length} | flagged ${flagged.length} | not cross-checkable ${notCrossRef.length}`);
for (const f of flagged) console.log(`  ⚠ ${f.country} ${f.indicator}: ${f.years.map((y) => y.year).join(', ')}`);
console.log(`  wrote ${MD_OUT} + ${JSON_OUT}`);
