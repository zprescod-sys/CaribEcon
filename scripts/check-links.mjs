/* Source-link checker — `npm run links:check`
 *
 * Walks every source URL in the data files and reports which no longer resolve,
 * so link rot is caught rather than discovered by a reader clicking a citation.
 *
 * Two things this deliberately does NOT treat as broken links:
 *
 *  - **imf.org 403.** Parts of imf.org sit behind an Akamai bot-WAF. It is
 *    selective, not blanket: DataMapper deep-links answer 200, while the WEO
 *    publication pages answer 403 to GET from an automated client though they
 *    load normally in a browser. Those are reported separately as EXPECTED so a
 *    real 404 elsewhere is never buried in noise.
 *
 *  - **api.worldbank.org** endpoints are machine APIs and are checked normally;
 *    they are the bulk of the list and should always return 200.
 *
 *  - **Publisher blocks and temporary server failures.** A challenge response,
 *    timeout, TLS error, or 5xx response does not prove that a reader-facing URL
 *    is broken. Those are reported as UNVERIFIED so they remain visible without
 *    creating false link-rot failures.
 *
 * Exit code is 1 only for definitive link-rot responses (404 or 410), so this is
 * safe to wire into CI.
 */

import { readFileSync } from 'node:fs';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;

const read = (p) => JSON.parse(readFileSync(new URL(`../data/${p}`, import.meta.url), 'utf8'));

/** Collects every URL in the data files, with a label for where it came from. */
function collect() {
  const urls = new Map(); // url -> Set(label)
  const add = (u, where) => {
    if (!u || !/^https?:/i.test(u)) return;
    if (!urls.has(u)) urls.set(u, new Set());
    urls.get(u).add(where);
  };

  for (const r of read('almanac-data.json')) {
    add(r.sourceUrl, `almanac ${r.country}/${r.indicator}`);
    add(r.sourceLanding, `almanac ${r.country}/${r.indicator} (landing)`);
  }
  for (const b of read('budgets.json')) add(b.sourceUrl, `budget ${b.country}`);
  try {
    for (const p of read('publications.json')) add(p.link ?? p.url, `publication`);
  } catch { /* optional file */ }
  try {
    for (const p of read('pub_inbox.json')) add(p.link ?? p.url, `publication inbox`);
  } catch { /* optional file */ }
  try {
    for (const n of read('news.json')) add(n.url, `news ${n.id ?? n.title}`);
  } catch { /* optional file */ }
  try {
    for (const n of read('news_unclassified.json')) {
      if (n.approved === true) add(n.url, `approved news ${n.id ?? n.title}`);
    }
  } catch { /* optional file */ }
  try {
    for (const d of read('deals.json')) add(d.url, `deal ${d.id ?? d.title}`);
  } catch { /* optional file */ }

  return urls;
}

async function check(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    // HEAD first — many of these are large PDFs we have no reason to download.
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA } });
    /* HEAD is unreliable across these hosts and must never be trusted for a
       failure verdict: api.worldbank.org answers HEAD with 404 and the same URL
       with 200 on GET, which produced four false "broken link" reports the first
       time this ran. Any non-2xx is therefore re-checked with GET before we
       call it broken. */
    if (!res.ok) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA } });
    }
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: err.name === 'AbortError' ? 'TIMEOUT' : 'ERROR', ok: false, detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Known publisher challenge responses; these URLs still load in a browser. */
function isExpectedBlock(url, status) {
  const host = new URL(url).hostname.replace(/^www\./, '');
  return (
    (host.endsWith('imf.org') && status === 403) ||
    (host === 'guyanachronicle.com' && status === 307) ||
    (host === 'rfhl.com' && status === 307) ||
    (host === 'caymancompass.com' && status === 403) ||
    (host === 'breakingbelizenews.com' && status === 403)
  );
}

/** Only explicit "not found" responses establish link rot. */
const isDefinitivelyBroken = (status) => status === 404 || status === 410;

async function main() {
  const urls = collect();
  const entries = [...urls.entries()];
  console.log(`Checking ${entries.length} source URLs…\n`);

  const results = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [url, where] = entries[cursor++];
        const r = await check(url);
        results.push({ url, where: [...where], ...r });
      }
    }),
  );

  const ok       = results.filter(r => r.ok);
  const expected = results.filter(r => !r.ok && isExpectedBlock(r.url, r.status));
  const broken   = results.filter(r => !r.ok && isDefinitivelyBroken(r.status));
  const unverified = results.filter(
    r => !r.ok && !isExpectedBlock(r.url, r.status) && !isDefinitivelyBroken(r.status),
  );

  console.log(`  OK            ${ok.length}`);
  console.log(`  BLOCKED       ${expected.length}  (known publisher challenge — fine in a browser)`);
  console.log(`  UNVERIFIED    ${unverified.length}  (temporary/server/TLS response; not proven broken)`);
  console.log(`  BROKEN        ${broken.length}\n`);

  if (unverified.length) {
    console.log('UNVERIFIED LINKS:');
    for (const r of unverified.sort((x, y) => String(x.status).localeCompare(String(y.status)))) {
      console.log(`  ${String(r.status).padStart(7)}  ${r.url}`);
      console.log(`           used by: ${r.where.slice(0, 4).join(', ')}${r.where.length > 4 ? ` +${r.where.length - 4} more` : ''}`);
      if (r.detail) console.log(`           ${r.detail}`);
    }
    console.log('');
  }

  if (broken.length) {
    console.log('BROKEN LINKS:');
    for (const b of broken.sort((x, y) => String(x.status).localeCompare(String(y.status)))) {
      console.log(`  ${String(b.status).padStart(7)}  ${b.url}`);
      console.log(`           used by: ${b.where.slice(0, 4).join(', ')}${b.where.length > 4 ? ` +${b.where.length - 4} more` : ''}`);
      if (b.detail) console.log(`           ${b.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log('No broken links.');
  }
}

main();
