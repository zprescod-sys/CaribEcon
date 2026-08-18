/* Tests for fetchArticleText() (src/lib/newsArticleFetch.ts).
 *
 * No mocks, no live network — same standing policy and same real-local-HTTP-server-stand-in
 * pattern as src/lib/ai/roles/interpret.test.mjs, adapted from "stand-in model provider" to
 * "stand-in news site": a real Node http server serves hand-crafted HTML fixtures and the
 * function under test does a real fetch() against http://127.0.0.1:<port>, so a test asserting
 * "article-tag content wins over nav/footer boilerplate" exercises the actual htmlToText pass,
 * not a mocked one that could silently drift from it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchArticleText } from './newsArticleFetch.ts';

const ARTICLE_HTML = `<!doctype html>
<html>
<head><title>Story</title><style>.x { color: red; }</style></head>
<body>
  <nav>Home | News | Business | NAV_MARKER_SHOULD_BE_EXCLUDED</nav>
  <header>Kaieteur News HEADER_MARKER_SHOULD_BE_EXCLUDED</header>
  <article>
    <h1>Guyana GDP grows 19.7% in first half of 2026</h1>
    <p>Guyana's economy expanded &amp; oil output rose, officials said.</p>
    <p>&quot;This is a strong result,&quot; the minister said.</p>
  </article>
  <aside>Related stories ASIDE_MARKER_SHOULD_BE_EXCLUDED</aside>
  <footer>&copy; 2026 Kaieteur News FOOTER_MARKER_SHOULD_BE_EXCLUDED</footer>
  <script>var trackingId = "FOOTER_SHOULD_NOT_LEAK"; console.log(trackingId);</script>
</body>
</html>`;

const BODY_ONLY_HTML = `<!doctype html>
<html><head><title>No article tag</title></head>
<body>
  <div class="content">
    <p>${'This story has no article or main wrapper, so extraction falls back to body. '.repeat(4)}</p>
  </div>
</body></html>`;

const NEAR_EMPTY_HTML = `<!doctype html>
<html><body><p>Enable JS.</p></body></html>`;

function oversizedHtml(totalChars) {
  const filler = 'x'.repeat(totalChars);
  return `<!doctype html><html><body><article><p>${filler}</p></article></body></html>`;
}

/* Stands up a stand-in "news site" server with one route per fixture and runs `run(baseUrl)`. */
async function withFixtureServer(run) {
  const server = createServer((req, res) => {
    if (req.url === '/article') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
    } else if (req.url === '/body-only') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(BODY_ONLY_HTML);
    } else if (req.url === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<html><body>Not found</body></html>');
    } else if (req.url === '/api-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url === '/near-empty') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(NEAR_EMPTY_HTML);
    } else if (req.url === '/oversized') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(oversizedHtml(50_000));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── Extraction correctness ──────────────────────────────────────────────────────────────────

test('extracts <article> content, excludes nav/header/footer/aside/script, and decodes entities', async () => {
  await withFixtureServer(async baseUrl => {
    const result = await fetchArticleText(`${baseUrl}/article`);
    assert.ok(result);
    assert.ok(result.text.includes('Guyana GDP grows 19.7%'));
    assert.ok(result.text.includes('expanded & oil output rose')); // &amp; decoded
    assert.ok(result.text.includes('"This is a strong result,"')); // &quot; decoded
    assert.ok(!result.text.includes('NAV_MARKER_SHOULD_BE_EXCLUDED'));
    assert.ok(!result.text.includes('HEADER_MARKER_SHOULD_BE_EXCLUDED'));
    assert.ok(!result.text.includes('ASIDE_MARKER_SHOULD_BE_EXCLUDED'));
    assert.ok(!result.text.includes('FOOTER_MARKER_SHOULD_BE_EXCLUDED'));
    assert.ok(!result.text.includes('FOOTER_SHOULD_NOT_LEAK')); // script content
    assert.equal(result.chars, result.text.length);
  });
});

test('falls back to <body> content when no <article> or <main> tag is present', async () => {
  await withFixtureServer(async baseUrl => {
    const result = await fetchArticleText(`${baseUrl}/body-only`);
    assert.ok(result);
    assert.ok(result.text.includes('This story has no article or main wrapper'));
  });
});

// ── Fail-soft on bad responses ──────────────────────────────────────────────────────────────

test('a 404 response returns null, not a throw', async () => {
  await withFixtureServer(async baseUrl => {
    const result = await fetchArticleText(`${baseUrl}/missing`);
    assert.equal(result, null);
  });
});

test('a non-HTML content-type (e.g. application/json) returns null', async () => {
  await withFixtureServer(async baseUrl => {
    const result = await fetchArticleText(`${baseUrl}/api-json`);
    assert.equal(result, null);
  });
});

test('a near-empty result after stripping returns null, same as a fetch failure', async () => {
  await withFixtureServer(async baseUrl => {
    const result = await fetchArticleText(`${baseUrl}/near-empty`);
    assert.equal(result, null);
  });
});

test('an unreachable host returns null, not a throw', async () => {
  // Port 1 is a reserved/unlisted TCP port practically guaranteed to refuse the connection.
  const result = await fetchArticleText('http://127.0.0.1:1/nope');
  assert.equal(result, null);
});

// ── Cap enforcement ──────────────────────────────────────────────────────────────────────────

test('MAX_EXTRACT_CHARS is respected on an oversized fixture', async () => {
  await withFixtureServer(async baseUrl => {
    const { MAX_EXTRACT_CHARS } = await import('./ai/config.ts');
    const result = await fetchArticleText(`${baseUrl}/oversized`);
    assert.ok(result);
    assert.ok(result.text.length <= MAX_EXTRACT_CHARS);
    assert.equal(result.text.length, MAX_EXTRACT_CHARS);
  });
});
