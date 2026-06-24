// build-feeds.mjs — News/Publications ingestion generator.
//
// Reads the Google Sheet buffer (filled by "RSS by Zapier") as public CSV and
// regenerates data/news.json + data/publications.json in the exact existing schema.
// No API keys (the sheet is shared read-only); the front end never calls this — it
// only consumes the committed JSON. Run by CI (.github/workflows/feeds.yml) or locally.
//
// Env:
//   SHEET_ID            Google Sheet id. If unset, reads local fixture CSVs instead.
//   NEWS_WINDOW_DAYS    drop news older than this many days (default 90)
//   NEWS_MAX            cap news to N most-recent after windowing (default 60)
//   OUT_NEWS/OUT_PUBS   output paths (default data/news.json, data/publications.json)
//   FIX_NEWS/FIX_PUBS   fixture CSV paths used when SHEET_ID is unset
//
// Usage:  node scripts/build-feeds.mjs        (live, needs SHEET_ID)
//         FIX_NEWS=... node scripts/build-feeds.mjs   (offline fixture test)
import fs from 'fs';
import crypto from 'crypto';

const SHEET_ID = process.env.SHEET_ID || '';
const NEWS_WINDOW_DAYS = Number(process.env.NEWS_WINDOW_DAYS || 90);
const NEWS_MAX = Number(process.env.NEWS_MAX || 60);
const OUT_NEWS = process.env.OUT_NEWS || 'data/news.json';
const OUT_PUBS = process.env.OUT_PUBS || 'data/publications.json';
const FIX_NEWS = process.env.FIX_NEWS || 'scripts/fixtures/news_inbox.sample.csv';
const FIX_PUBS = process.env.FIX_PUBS || 'scripts/fixtures/pub_inbox.sample.csv';

const COUNTRIES = new Set(['TT','GY','BB','JM','BS','KY','BZ','SR','GD','LC','AG','KN','DM','VC','TC','VG']);
const PUB_TYPES = new Set(['Article IV','World Economic Outlook','Staff Report','Country Report',
  'Working Paper','Development Report','Regional Economic Outlook','Other']);

const warns = [];
const warn = (m) => warns.push(m);

// ── CSV (RFC-4180-ish: quoted fields, doubled quotes, newlines in quotes) ──────
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, q = false;
  text = text.replace(/\r\n?/g, '\n');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// CSV rows -> array of objects keyed by header (trimmed, lower-cased)
function toRecords(csv) {
  const rows = parseCSV(csv).filter(r => r.some(c => c.trim() !== ''));
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  return rows.slice(1).map(r => Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? '').trim()])));
}

async function getJSON_text(url) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(url); if (r.ok) return await r.text(); } catch {}
    await new Promise(r => setTimeout(r, 500 * (t + 1)));
  }
  throw new Error('fetch failed: ' + url);
}

async function loadTab(tab, fixturePath) {
  if (!SHEET_ID) {
    if (!fs.existsSync(fixturePath)) { warn(`no SHEET_ID and missing fixture ${fixturePath}`); return []; }
    return toRecords(fs.readFileSync(fixturePath, 'utf8'));
  }
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  const text = await getJSON_text(url);
  // A private sheet / wrong id returns Google's HTML app shell, not CSV — fail loudly
  // rather than silently wiping the page to empty.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    throw new Error(`Sheet tab "${tab}" did not return CSV — is the sheet shared "Anyone with the link: Viewer" and the tab named exactly "${tab}"?`);
  }
  return toRecords(text);
}

// ── helpers ───────────────────────────────────────────────────────────────────
const slug = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const toISO = (raw) => { const d = new Date(raw); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
const isUrl = (u) => /^https?:\/\//i.test(u || '');

// country cell -> "ALL"/"REGION" string, single code, or array of codes
function parseCountry(raw, regional) {
  const v = (raw || '').trim();
  if (!v) return regional;                                   // empty -> ALL / REGION
  if (v.toUpperCase() === regional) return regional;
  const codes = v.split(/[,;]/).map(s => s.trim().toUpperCase()).filter(Boolean);
  const bad = codes.filter(c => !COUNTRIES.has(c) && c !== regional);
  if (bad.length) return { error: `unknown country code(s): ${bad.join(', ')}` };
  if (codes.includes(regional)) return regional;
  return codes.length === 1 ? codes[0] : codes;
}

// ── News ────────────────────────────────────────────────────────────────────
function buildNews(records) {
  const out = [];
  for (const r of records) {
    if (!r.title || !r.source || !r.url) { warn(`news: missing title/source/url — "${(r.title||'').slice(0,40)}"`); continue; }
    if (!isUrl(r.url)) { warn(`news: bad url "${r.url}"`); continue; }
    const date = toISO(r.date);
    if (!date) { warn(`news: bad date "${r.date}" — "${r.title.slice(0,40)}"`); continue; }
    const country = parseCountry(r.country, 'ALL');
    if (country && country.error) { warn(`news: ${country.error} — "${r.title.slice(0,40)}"`); continue; }
    const tags = (r.tags || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const item = { id: `${slug(r.source)}-${shortHash(r.url)}`, title: r.title, source: r.source, date, country, url: r.url };
    if (tags.length) item.tags = tags;
    out.push(item);
  }
  // dedup by id (canonical url), window, sort desc, cap
  const seen = new Set();
  let deduped = out.filter(i => (seen.has(i.id) ? false : seen.add(i.id)));
  const cutoff = new Date(Date.now() - NEWS_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const windowed = deduped.filter(i => i.date >= cutoff);
  windowed.sort((a, b) => b.date.localeCompare(a.date));
  const capped = windowed.slice(0, NEWS_MAX);
  return { items: capped, stats: { parsed: records.length, valid: out.length, deduped: deduped.length, windowed: windowed.length, published: capped.length } };
}

// ── Publications (editorial gate: approved + summary + type) ───────────────────
function buildPubs(records) {
  const out = [];
  for (const r of records) {
    if (String(r.approved || '').trim().toUpperCase() !== 'TRUE') continue;   // only approved rows
    const org = r.org || r.body || '';
    if (!r.title || !org || !r.url) { warn(`pub: missing title/org/url — "${(r.title||'').slice(0,40)}"`); continue; }
    if (!isUrl(r.url)) { warn(`pub: bad url "${r.url}"`); continue; }
    const date = toISO(r.date);
    if (!date) { warn(`pub: bad date "${r.date}" — "${r.title.slice(0,40)}"`); continue; }
    if (!r.summary) { warn(`pub: approved but missing editorial summary — "${r.title.slice(0,40)}"`); continue; }
    if (!PUB_TYPES.has(r.type)) { warn(`pub: invalid type "${r.type}" — "${r.title.slice(0,40)}"`); continue; }
    const country = parseCountry(r.country, 'REGION');
    if (country && country.error) { warn(`pub: ${country.error} — "${r.title.slice(0,40)}"`); continue; }
    out.push({ id: `${slug(org)}-${shortHash(r.url)}`, title: r.title, body: org, type: r.type, date, country, summary: r.summary, url: r.url });
  }
  const seen = new Set();
  const deduped = out.filter(p => (seen.has(p.id) ? false : seen.add(p.id)));
  deduped.sort((a, b) => b.date.localeCompare(a.date));
  return { items: deduped, stats: { parsed: records.length, approved_published: deduped.length } };
}

// write only if content actually changed (keeps CI commits clean)
function writeIfChanged(path, items) {
  const next = JSON.stringify(items, null, 2) + '\n';
  const prev = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
  if (next === prev) { console.log(`unchanged: ${path}`); return false; }
  fs.writeFileSync(path, next); console.log(`wrote:     ${path} (${items.length})`); return true;
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(SHEET_ID ? `source: live sheet ${SHEET_ID}` : `source: local fixtures (no SHEET_ID)`);
const [newsRows, pubRows] = await Promise.all([loadTab('news_inbox', FIX_NEWS), loadTab('pub_inbox', FIX_PUBS)]);
const news = buildNews(newsRows);
const pubs = buildPubs(pubRows);
console.log('news:', JSON.stringify(news.stats), '\npubs:', JSON.stringify(pubs.stats));
const changedN = writeIfChanged(OUT_NEWS, news.items);
const changedP = writeIfChanged(OUT_PUBS, pubs.items);
if (warns.length) { console.log(`\nwarnings (${warns.length}):`); warns.forEach(w => console.log('  ⚠', w)); }
// signal "changed" to CI via exit-code-free marker file (workflow greps committed files)
console.log(`\nchanged: ${changedN || changedP ? 'yes' : 'no'}`);
