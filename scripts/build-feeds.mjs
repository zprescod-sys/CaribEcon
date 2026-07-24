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
import {
  isDisplayableNews,
  getNewsReviewDecision,
  NEWS_CATEGORY_GROUPS,
} from '../src/lib/newsRelevance.mjs';

// ── Config ───────────────────────────────────────────────────────────────────
const NEWS_WINDOW_DAYS  = Number(process.env.NEWS_WINDOW_DAYS ?? 120);  // keep this much history in the archive
const NEWS_MAX          = Number(process.env.NEWS_MAX ?? 2000);         // hard safety bound on total
const FINANCE_FILTER    = process.env.FINANCE_FILTER !== '0';           // keep only financial/economic items
// Promote-only: skip the news fetch so a local deal/publication approval never
// rewrites data/news.json (which the daily CI cron owns) — avoids merge conflicts.
// Run via `npm run promote`. The daily workflow runs the full `npm run feeds`.
const PROMOTE_ONLY      = process.argv.includes('--promote-only') || process.env.PROMOTE_ONLY === '1';
const AUDIT_ONLY        = process.argv.includes('--audit-only');
const UA = 'Mozilla/5.0 (compatible; CaribbeanMacroAlmanac/1.0; +https://github.com/) feeds-bot';

// Economic-relevance filter — the rule lives in src/lib/newsRelevance.mjs so ingest
// (here) and render (src/lib/dataHub.ts) can never drift. Precision-first: an economic
// keyword is required, and any sport/crime/lifestyle signal drops the item unless a
// strong, unambiguous economic term also appears. See that module for the full policy.
function isFinancial(title, tags = []) {
  if (!FINANCE_FILTER) return true;
  return isDisplayableNews(title, tags);
}

const NEWS_CATEGORIES = new Set(Object.keys(NEWS_CATEGORY_GROUPS));

// Validate only editor-controlled fields. Unapproved rows may keep category blank;
// approved rows must be complete enough for the data hub to publish safely.
function validateNewsReviewInbox(rows) {
  const seen = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row?.id || !row.title || !row.source || !row.date || !row.url || !row.country) {
      throw new Error(`data/news_unclassified.json row ${index + 1} is missing required news fields`);
    }
    if (seen.has(row.id)) throw new Error(`data/news_unclassified.json has duplicate id "${row.id}"`);
    seen.add(row.id);
    if (row.category && !NEWS_CATEGORIES.has(row.category)) {
      throw new Error(`data/news_unclassified.json row ${index + 1} has invalid category "${row.category}"`);
    }
    if (row.approved === true && !NEWS_CATEGORIES.has(row.category)) {
      throw new Error(`data/news_unclassified.json row ${index + 1} is approved but has no valid category`);
    }
  }
}

// The 19 country codes (mirror dataHub.ts) + ALL for pan-Caribbean.
const COUNTRIES = new Set(['GY','TT','BB','JM','BS','BZ','SR','GD','LC','AG','KN','DM','VC','TC','KY','VG','HT','AW','CW','ALL']);

// ── Deal detector ──────────────────────────────────────────────────────────────
// Mine the (already finance-filtered) news set for genuine transactions and stage
// them in data/deals_inbox.json. The filter is deliberately strict to keep noise
// out: an item qualifies only if its title names a deal action AND a money/scale
// figure, OR it contains a single high-confidence standalone phrase. Candidates are
// editorial — a human fills value/parties/type and sets approved:true before they
// promote to data/deals.json.
const DEAL_VERB_RE = new RegExp('\\b(?:' + [
  'acquir', 'acquisit', 'merger', 'buyout', 'takeover', 'divest', 'divestiture',
  'privatiz', 'recapitaliz', 'refinanc', 'concession', 'tender offer',
  'stake in', 'majority stake', 'equity stake', 'bond issue', 'bond issuance',
].join('|') + ')', 'i');
// A currency-tagged amount, or a number with a scale word (bn/mn/billion/million).
const MONEY_RE = /(?:us\$|usd|ttd|gyd|jmd|bbd|bsd|xcd|\$)\s?\d|\b\d+(?:\.\d+)?\s?(?:bn|billion|mn|million|trillion)\b/i;
// High-confidence phrases that stand alone (no money figure required).
const DEAL_PHRASES = [
  'final investment decision', 'joint venture', 'completes acquisition',
  'completed acquisition', 'initial public offering', 'bond issuance',
  'sovereign bond', 'rights issue', 'tender offer', 'takeover bid',
  'completes takeover', 'completed takeover', 'takes control of',
  'takes effective control', 'majority stake in', 'all-share deal',
  'share exchange',
];

// A deal-verb hit + a share/equity signal also qualifies (covers all-stock M&A where no
// cash value is stated in the headline — the MONEY_RE would miss these).
const SHARE_SIGNAL_RE = /\b(?:shares?|stock|equity|all.?share|all.?stock)\b/i;

function isDeal(title) {
  const hay = String(title).toLowerCase();
  const hasVerb = DEAL_VERB_RE.test(hay);
  return (hasVerb && (MONEY_RE.test(hay) || SHARE_SIGNAL_RE.test(hay)))
    || DEAL_PHRASES.some(p => hay.includes(p));
}

// Suggest a DealType (src/lib/types.ts) from the title; the human can correct it.
function inferDealType(title) {
  const t = String(title).toLowerCase();
  if (/\bipo\b|initial public offering|rights issue|lists on/.test(t)) return 'IPO';
  if (/bond|eurobond|sovereign|note issue/.test(t)) return 'Bond';
  if (/joint venture|\bjv\b/.test(t)) return 'JV';
  if (/concession|licen[cs]e/.test(t)) return 'Concession';
  if (/acquir|acquisit|merger|buyout|takeover|stake|divest/.test(t)) return 'M&A';
  if (/invest|fdi|final investment decision/.test(t)) return 'FDI';
  return 'Other';
}

const REPORT = [];
const log = (s) => { REPORT.push(s); console.log(s); };
const parser = new Parser({ headers: { 'User-Agent': UA }, timeout: 20000 });

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const shortHash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const newsId = (source, url) => `${slug(source)}-${shortHash(url)}`;
const dealId = (url) => `deal-${shortHash(url)}`;

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

// Missing file -> fallback (first run). Malformed file (e.g. a stray comma from a
// hand-edit) -> abort the whole run instead of silently treating it as empty, which
// would otherwise get written back out and wipe every curated record it held.
function readJSON(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) {
    console.error(`FATAL: ${path} is not valid JSON — fix it before rerunning.\n${e.message}`);
    process.exit(1);
  }
}
const writeJSON = (path, data) => fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');

// ── News ─────────────────────────────────────────────────────────────────────
async function buildNews({ auditOnly = false } = {}) {
  const feeds = readJSON('./data/feeds.json', []);
  // Fail fast on editorial-data mistakes before spending time and requests fetching
  // every feed. These rows are merged again after the full archive is assessed.
  const existingReview = readJSON('./data/news_unclassified.json', []);
  validateNewsReviewInbox(existingReview);
  const fetched = [];
  const fetchedReviewContext = new Map();

  for (const feed of feeds) {
    try {
      const xml = await fetchFeed(feed.url, feed.insecureTLS);
      const parsed = await parser.parseString(xml);
      const businessFeed = /(?:category\/business|feed\/business|[?&]c=business)/i.test(feed.url);
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
        const record = {
          id: newsId(feed.source, url), title, source: feed.source,
          date, country: feed.country, url, ...(tags.length ? { tags } : {}),
        };
        fetched.push(record);
        const previousContext = fetchedReviewContext.get(record.id);
        fetchedReviewContext.set(record.id, {
          businessFeed: Boolean(previousContext?.businessFeed || businessFeed),
        });
        added++;
      }
      log(`  ✓ ${feed.source} (${feed.country}) — ${added} items${skipped ? `, ${skipped} skipped` : ''}`);
    } catch (e) {
      log(`  ✗ ${feed.source} (${feed.country}) — FAILED: ${e.message}`);
    }
  }

  const cutoff = new Date(Date.now() - NEWS_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);

  // Assess the union, not only the newest RSS window. This is the migration safety
  // property: when policy changes, an older medium story reaches review before it can
  // disappear from the public archive.
  const existing = readJSON('./data/news.json', []);
  const byId = new Map();
  for (const it of existing) byId.set(it.id ?? newsId(it.source, it.url), it);
  let net = 0;
  for (const it of fetched) if (!byId.has(it.id)) { byId.set(it.id, it); net++; }
  const inWindow = [...byId.values()].filter(it => it.date >= cutoff);

  const reviewCandidates = [];
  for (const record of inWindow) {
    const review = getNewsReviewDecision(
      record.title,
      record.tags ?? [],
      fetchedReviewContext.get(record.id) ?? {},
    );
    if (!review.candidate) continue;
    reviewCandidates.push({
      ...record,
      approved: false,
      category: '',
      suggestedCategory: review.suggestedCategory,
      confidence: review.confidence,
      reason: review.reason,
    });
  }

  // Stage plausible rejected stories non-destructively. Refresh machine-owned feed
  // metadata and suggestions, but preserve the two editor-owned fields (category and
  // approval). Old unapproved rows age out with the news window; approved rows remain
  // until an editor removes them.
  const reviewById = new Map(existingReview.map(row => [row.id, row]));
  const fetchedIds = new Set(fetched.map(row => row.id));
  const currentCandidateIds = new Set(reviewCandidates.map(row => row.id));
  let reviewAdded = 0;
  for (const candidate of reviewCandidates) {
    const existing = reviewById.get(candidate.id);
    if (!existing) {
      reviewById.set(candidate.id, candidate);
      reviewAdded++;
      continue;
    }
    reviewById.set(candidate.id, {
      ...candidate,
      approved: existing.approved === true,
      category: existing.category ?? '',
    });
  }
  const reviewInbox = [...reviewById.values()]
    .filter(row => row.approved === true || (
      row.date >= cutoff
      // If a still-live feed item no longer meets the selective rule, clean it out.
      && (!fetchedIds.has(row.id) || currentCandidateIds.has(row.id))
    ))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  validateNewsReviewInbox(reviewInbox);
  writeJSON('./data/news_unclassified.json', reviewInbox);
  log(`News review inbox: ${reviewAdded} new candidates, ${reviewInbox.length} total, ${reviewInbox.filter(row => row.approved === true).length} approved.`);

  // The editorial audit command refreshes only the review inbox. It must never
  // rewrite the CI-owned public archive or touch deals/publications.
  if (auditOnly) return;

  // Keep the full financial/economic archive within the time window (so /news can
  // paginate all of it); window -> finance filter -> sort newest-first -> safety bound.
  // The finance filter is applied to the whole union so items saved before the filter
  // existed are cleaned out too.
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  const merged = inWindow
    .filter(it => isFinancial(it.title, it.tags ?? []))
    .sort(byDateDesc)
    .slice(0, NEWS_MAX);

  writeJSON('./data/news.json', merged);
  log(`News: ${fetched.length} fetched, ${net} new this run, ${merged.length} in archive (financial-only, window ${NEWS_WINDOW_DAYS}d).`);
}

// ── Publications (editorial-in-the-loop) ───────────────────────────────────────
// Publications are curated by hand. New rows are entered into data/pub_inbox.json
// (the IMF auto-discovery feeds were removed — they block datacenter IPs); a human
// fills type + summary and sets approved:true, then they promote here without
// clobbering existing curated records. See data/SCHEMA.md for the policy.
async function buildPublications() {
  const inbox = readJSON('./data/pub_inbox.json', []);

  // Promote approved rows into publications.json WITHOUT clobbering curated records.
  const pubs = readJSON('./data/publications.json', []);
  const byId = new Map(pubs.map(p => [p.id, p]));
  let promoted = 0;
  for (const r of inbox) {
    if (r.approved === true && r.type && r.summary && !byId.has(r.id)) {
      const { approved, ...pub } = r;          // drop the staging-only flag
      byId.set(r.id, pub); promoted++;
    }
  }
  writeJSON('./data/publications.json', [...byId.values()]);
  log(`Publications: ${promoted} promoted from inbox, ${byId.size} total.`);
}

// ── Deals (mined from news, editorial-in-the-loop) ─────────────────────────────
// Scan the merged news set (already written + finance-filtered) for genuine
// transactions and stage candidates in data/deals_inbox.json. A human fills
// value/parties/type and sets approved:true, then approved rows promote to
// data/deals.json without clobbering the curated headline records.
async function buildDeals() {
  const news = readJSON('./data/news.json', []);
  const inbox = readJSON('./data/deals_inbox.json', []);
  const byUrl = new Map(inbox.map(r => [r.url, r]));
  let discovered = 0;

  for (const item of news) {
    if (!isDeal(item.title) || byUrl.has(item.url)) continue;
    // New inbox row: human fills value + parties, confirms type, sets approved:true.
    const row = {
      id: dealId(item.url), headline: item.title, parties: '', value: '',
      date: item.date, country: item.country, type: '',
      suggestedType: inferDealType(item.title), url: item.url,
      source: item.source, approved: false,
    };
    byUrl.set(item.url, row); discovered++;
  }
  const newInbox = [...byUrl.values()];
  writeJSON('./data/deals_inbox.json', newInbox);

  // Promote approved rows into deals.json WITHOUT clobbering curated records.
  const deals = readJSON('./data/deals.json', []);
  const byId = new Map(deals.map(d => [d.id, d]));
  let promoted = 0;
  for (const r of newInbox) {
    if (r.approved === true && r.type && r.headline && !byId.has(r.id)) {
      const { approved, suggestedType, ...deal } = r;  // drop staging-only fields
      byId.set(r.id, deal); promoted++;
    }
  }
  writeJSON('./data/deals.json', [...byId.values()]);
  log(`Deals: ${discovered} new candidates in inbox, ${promoted} promoted, ${byId.size} total.`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
if (AUDIT_ONLY) {
  log('News audit mode: refreshing selective review inbox only (news.json left untouched).');
  await buildNews({ auditOnly: true });
} else if (PROMOTE_ONLY) {
  log('Promote-only mode: skipping news fetch (data/news.json left untouched).');
  const reviewInbox = readJSON('./data/news_unclassified.json', []);
  validateNewsReviewInbox(reviewInbox);
  log(`News review inbox: ${reviewInbox.filter(row => row.approved === true).length} approved rows validated for data-hub merge.`);
} else {
  log('Fetching news feeds…');
  await buildNews();
}
if (!AUDIT_ONLY) {
  log('Mining deals from news…');
  await buildDeals();
  log('Promoting approved publications…');
  await buildPublications();
}
log('Done.');
