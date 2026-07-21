// Validate data/almanac-data.json against the frozen schema constraints (see data/SCHEMA.md).
// Exits non-zero on any error, so the weekly refresh workflow fails loudly rather than
// proposing a corrupt dataset. Run: npm run data:validate
import fs from 'fs';

const data = JSON.parse(fs.readFileSync('./data/almanac-data.json', 'utf8'));
const meta = JSON.parse(fs.readFileSync('./data/indicator-meta.json', 'utf8'));

const SLUGS = new Set(Object.keys(meta));
const COUNTRIES = new Set([
  'TT', 'GY', 'BB', 'JM', 'BS', 'BZ', 'SR', 'GD', 'LC', 'AG',
  'KN', 'DM', 'VC', 'TC', 'KY', 'VG', 'HT', 'AW', 'CW',   // 19 economies
]);
const TIER = new Set(['primary', 'comparable']);
const CONF = new Set(['high', 'medium', 'flagged']);
const TYPE = new Set(['actual', 'estimate', 'projection', 'derived']);
const MIN_YEAR = 2015;
const MAX_YEAR = new Date().getFullYear();   // frontier advances with the calendar

const errs = [], warns = [];

for (const r of data) {
  const id = `${r.country}|${r.indicator}`;
  if (!COUNTRIES.has(r.country)) errs.push(`${id}: bad country`);
  if (!SLUGS.has(r.indicator)) errs.push(`${id}: slug not in indicator-meta`);
  for (const f of ['indicatorLabel', 'unit', 'source', 'sourceOrg', 'sourceUrl']) if (!r[f]) errs.push(`${id}: missing ${f}`);
  if (!TIER.has(r.sourceTier)) errs.push(`${id}: bad sourceTier ${r.sourceTier}`);
  if (!CONF.has(r.confidence)) errs.push(`${id}: bad confidence ${r.confidence}`);
  if (!Array.isArray(r.series)) { errs.push(`${id}: no series`); continue; }
  const seenYears = new Set();
  for (const p of r.series) {
    if (seenYears.has(p.year)) errs.push(`${id}: duplicate year ${p.year}`);
    seenYears.add(p.year);
    if (p.year < MIN_YEAR || p.year > MAX_YEAR) warns.push(`${id}: year ${p.year} outside ${MIN_YEAR}-${MAX_YEAR}`);
    if (!TYPE.has(p.type)) errs.push(`${id}: bad type ${p.type} @${p.year}`);
    if (p.value !== null && typeof p.value !== 'number') errs.push(`${id}: non-numeric value @${p.year}`);
    if (!/^\d{4}(-\d{2})?$/.test(String(p.vintage || ''))) errs.push(`${id}: bad vintage "${p.vintage}" @${p.year}`);
  }
}

// Debt cross-check: gross_govt_debt / nominal_gdp ≈ gross_govt_debt_pct_gdp (same country/year)
const byKey = {};
for (const r of data) for (const p of r.series) if (p.value != null) byKey[`${r.country}|${r.indicator}|${p.year}`] = p.value;
for (const r of data) if (r.indicator === 'gross_govt_debt_pct_gdp') for (const p of r.series) {
  if (p.value == null) continue;
  const lvl = byKey[`${r.country}|gross_govt_debt|${p.year}`], gdp = byKey[`${r.country}|nominal_gdp|${p.year}`];
  if (lvl != null && gdp != null) {
    const calc = lvl / gdp * 100, diff = Math.abs(calc - p.value);
    if (diff > 8) warns.push(`${r.country} ${p.year}: debt% ${p.value} vs level/gdp ${calc.toFixed(1)} (Δ${diff.toFixed(1)})`);
  }
}

console.log(`records: ${data.length} | points: ${data.reduce((n, r) => n + r.series.length, 0)}`);
console.log(`ERRORS: ${errs.length}`); errs.slice(0, 40).forEach((e) => console.log('  ✗', e));
console.log(`WARNINGS: ${warns.length}`); warns.slice(0, 40).forEach((w) => console.log('  ⚠', w));
process.exit(errs.length ? 1 : 0);
