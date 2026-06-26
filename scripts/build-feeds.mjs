/* Feeds builder — fetches the RSS/Atom feeds listed in data/feeds.json, normalises
 * each item to the NewsItem schema (src/lib/types.ts), and MERGES them into
 * data/news.json. Run daily by .github/workflows/feeds.yml, or locally: npm run feeds.
 *
 * Design notes:
 *  - MERGE, never replace: a daily run only sees what is currently in each feed
 *    (~last 10-20 items). We union new items into the already-stored set keyed by a
 *    stable id, so an item persists on the site even after it scrolls off the source
 *    feed. The committed JSON is the durable store (GitHub runners are stateless).
 *  - News rolls to a recent window/cap; Publications are NEVER overwritten — they are
 *    curated, and only grow via approved rows promoted from data/pub_inbox.json.
 *  - Resilient: a feed that fails (403 / TLS / malformed XML) is logged and skipped,
 *    never crashing the run.
 */
import fs from 'fs';
import crypto from 'crypto';
import Parser from 'rss-parser';

// ── Config ───────────────────────────────────────────────────────────────────
const NEWS_WINDOW_DAYS  = Number(process.env.NEWS_WINDOW_DAYS ?? 120);  // keep this much history in the archive
const NEWS_MAX          = Number(process.env.NEWS_MAX ?? 2000);         // hard safety bound on total
const FINANCE_FILTER    = process.env.FINANCE_FILTER !== '0';           // keep only financial/economic items
const UA = 'Mozilla/5.0 (compatible; CaribbeanMacroAlmanac/1.0; +https://github.com/) feeds-bot';

// Financial / economic relevance filter. Items whose title or tags match are kept;
// everything else is dropped at ingestion. Heuristic + tunable: stems (e.g. "econom"
// matches economy/economic), whole tokens, and a few multi-word phrases. Matched on a
// word boundary to avoid false hits (e.g. "import" not "important", "port" excluded).
const FIN_RE = new RegExp('\\b(?:' + [
  'econom', 'financ', 'fiscal', 'monetar', 'inflation', 'deflation', 'budget', 'deficit',
  'surplus', 'debt', 'gdp', 'imf', 'eclac', 'tax', 'tariff', 'trade', 'export', 'import',
  'invest', 'fdi', 'oil', 'gas', 'petroleum', 'energy', 'lng', 'refiner', 'tourism', 'tourist',
  'currenc', 'devalu', 'revenue', 'fintech', 'bank', 'loan', 'credit', 'bond', 'treasur',
  'market', 'stock', 'ipo', 'business', 'commerce', 'manufactur', 'agricultur', 'mining',
  'bauxite', 'shipping', 'logistic', 'employ', 'unemploy', 'job', 'labou?r', 'wage', 'salar',
  'pension', 'recession', 'growth', 'productiv', 'subsid', 'price', 'remittance', 'reserve',
  'default', 'restructur', 'rating', 'procurement', 'merger', 'acquisition', 'privatiz',
  'infrastructure', 'construction', 'housing', 'insurance', 'forex', 'crypto', 'bitcoin', 'fund',
].join('|') + ')', 'i');
const FIN_PHRASES = ['world bank', 'central bank', 'interest rate', 'exchange rate',
  'real estate', 'cost of living', 'credit rating', 'sovereign wealth', 'natural resource fund',
  'private sector', 'gross domestic'];

function isFinancial(title, tags = []) {
  if (!FINANCE_FILTER) return true;
  const hay = `${title} ${tags.join(' ')}`.toLowerCase();
  return FIN_RE.test(hay) || FIN_PHRASES.some(p => hay.includes(p));
}

// The 16 country codes (mirror dataHub.ts) + ALL for pan-Caribbean.
const COUNTRIES = new Set(['GY','TT','BB','JM','BS','BZ','SR','GD','LC','AG','KN','DM','VC','TC','KY','VG','ALL']);

// IMF per-country news — best-effort source for the Publications inbox. IMF often
// blocks datacenter IPs (403); failures are skipped. Publications stay editorial.
const PUB_FEEDS = [
  ['GY','GUY'],['TT','TTO'],['BB','BRB'],['JM','JAM'],['BS','BHS'],['BZ','BLZ'],
  ['SR','SUR'],['GD','GRD'],['LC','LCA'],['AG','ATG'],['KN','KNA'],['DM','DMA'],['VC','VCT'],
].map(([country, iso3]) => ({
  country, org: 'International Monetary Fund',
  url: `https://www.imf.org/en/news/rss?Language=ENG&Country=${iso3}`,
}));

const REPORT = [];
const log = (s) => { REPORT.push(s); console.log(s); };
const parser = new Parser({ headers: { 'User-Agent': UA }, timeout: 20000 });

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const newsId = (source, url) => `${slug(source)}-${shortHash(url)}`;

// "2026-06-24T..." | "Tue, 24 Jun 2026 ..." -> "2026-06-24", or null if unparseable.
function toISODate(item) {
  const raw = item.isoDate || item.pubDate || item.published || item.updated;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Fetch feed text with a browser UA + retry. For TLS-broken feeds (expired/incomplete
// cert) flagged in feeds.json, relax verification just for that fetch.
async function fetchFeed(url, insecureTLS, tries = 3) {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecureTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
        });
        if (res.ok) return await res.text();
        lastErr = new Error(`HTTP ${res.status}`);
      } catch (e) { lastErr = e; }
      await sleep(500 * (i + 1));
    }
    throw lastErr ?? new Error('unknown fetch error');
  } finally {
    if (insecureTLS) {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  }
}

function readJSON(path, fallback) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return fallback; }
}
const writeJSON = (path, data) => fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

// ── News ─────────────────────────────────────────────────────────────────────
async function buildNews() {
  const feeds = readJSON('./data/feeds.json', []);
  const fetched = [];

  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url, feed.insecureTLS);
      const parsed = await parser.parseString(xml);
      let added = 0, skipped = 0;
      for (const item of (parsed.items ?? [])) {
        const url = (item.link || item.guid || '').trim();
        const title = (item.title || '').trim();
        const date = toISODate(item);
        // Validate: link, title, parseable date, known country.
        if (!url || !/^https?:\/\//i.test(url) || !title || !date || !COUNTRIES.has(feed.country)) {
          skipped++; continue;
        }
        const tags = (item.categories ?? [])
          .map(c => (typeof c === 'string' ? c : c?._ ?? '').trim().toLowerCase())
          .filter(Boolean).slice(0, 6);
        fetched.push({
          id: newsId(feed.source, url), title, source: feed.source,
          date, country: feed.country, url, ...(tags.length ? { tags } : {}),
        });
        added++;
      }
      log(`  ✓ ${feed.source} (${feed.country}) — ${added} items${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (e) {
      log(`  ✗ ${feed.source} (${feed.country}) — FAILED: ${e.message}`);
    }
  }

  // Merge with the existing store (union by id — keep whichever copy we already had,
  // so previously-captured items survive after they leave the source feed).
  const existing = readJSON('./data/news.json', []);
  const byId = new Map();
  for (const it of existing) byId.set(it.id ?? newsId(it.source, it.url), it);
  let net = 0;
  for (const it of fetched) if (!byId.has(it.id)) { byId.set(it.id, it); net++; }

  // Keep the full financial/economic archive within the time window (so /news can
  // paginate all of it); window -> finance filter -> sort newest-first -> safety bound.
  // The finance filter is applied to the whole union so items saved before the filter
  // existed are cleaned out too.
  const cutoff = new Date(Date.now() - NEWS_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const merged = [...byId.values()]
    .filter(it => it.date >= cutoff && isFinancial(it.title, it.tags ?? []))
    .sort(byDateDesc)
    .slice(0, NEWS_MAX);

  writeJSON('./data/news.json', merged);
  log(`News: ${fetched.length} fetched, ${net} new this run, ${merged.length} in archive (financial-only, window ${NEWS_WINDOW_DAYS}d).`);
}

// ── Publications (editorial-in-the-loop) ───────────────────────────────────────
async function buildPublications() {
  const inbox = readJSON('./data/pub_inbox.json', []);
  const byUrl = new Map(inbox.map(r => [r.url, r]));
  let discovered = 0;

  for (const feed of PUB_FEEDS) {
    try {
      const xml = await fetchFeed(feed.url, false);
      const parsed = await parser.parseString(xml);
      for (const item of (parsed.items ?? [])) {
        const url = (item.link || '').trim();
        const title = (item.title || '').trim();
        const date = toISODate(item);
        if (!url || !title || !date || byUrl.has(url)) continue;
        // New inbox row: human fills type + summary, then sets approved: true.
        const row = {
          id: `${slug(feed.org)}-${shortHash(url)}`, title, body: feed.org,
          type: '', date, country: feed.country, summary: '', url, approved: false,
        };
        byUrl.set(url, row); discovered++;
      }
      log(`  ✓ pub ${feed.country} (${feed.org})`);
    } catch (e) {
      log(`  ✗ pub ${feed.country} (${feed.org}) — ${e.message}`);
    }
  }
  const newInbox = [...byUrl.values()];
  writeJSON('./data/pub_inbox.json', newInbox);

  // Promote approved rows into publications.json WITHOUT clobbering curated records.
  const pubs = readJSON('./data/publications.json', []);
  const byId = new Map(pubs.map(p => [p.id, p]));
  let promoted = 0;
  for (const r of newInbox) {
    if (r.approved === true && r.type && r.summary && !byId.has(r.id)) {
      const { approved, ...pub } = r;          // drop the staging-only flag
      byId.set(r.id, pub); promoted++;
    }
  }
  writeJSON('./data/publications.json', [...byId.values()]);
  log(`Publications: ${discovered} new in inbox, ${promoted} promoted, ${byId.size} total.`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
log('Fetching news feeds…');
await buildNews();
log('Fetching publication feeds…');
await buildPublications();
log('Done.');
