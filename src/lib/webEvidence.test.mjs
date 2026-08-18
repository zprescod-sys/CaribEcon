/* Tests for searchWeb()/extractWeb() (src/lib/webEvidence.ts).
 *
 * No mocks, no live network — same real-local-HTTP-server-stand-in pattern as
 * src/lib/ai/roles/interpret.test.mjs and src/lib/newsArticleFetch.test.mjs: a real Node http
 * server serves hand-crafted fixtures shaped EXACTLY like the real Tavily Search/Extract
 * responses confirmed live during Step 1 of this module's build (see webEvidence.ts's header
 * comment for the confirmed field names), and TAVILY_API_KEY plus a monkey-patched global
 * `fetch` point the module under test at http://127.0.0.1:<port> instead of api.tavily.com. That
 * way a test asserting "content maps to snippet" exercises the actual parsing code, not a mocked
 * stand-in that could silently drift from it.
 *
 * webEvidence.ts hardcodes the real Tavily hostnames (https://api.tavily.com/...) rather than
 * taking a base URL as a parameter — there was no existing seam to redirect requests through, so
 * these tests monkey-patch globalThis.fetch for the duration of each test and restore the real
 * one afterward. Every fixture server route below still exercises real HTTP end-to-end (real
 * sockets, real JSON serialization) — only the *destination host* is substituted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { searchWeb, extractWeb } from './webEvidence.ts';

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/* Sets exactly the given env vars for the duration of `run`, restoring each key afterward — same
   helper as interpret.test.mjs/config.test.mjs, duplicated on purpose so this file runs standalone. */
function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/* Stands up a fixture server whose routes are keyed by request pathname (`/search`, `/extract`,
   etc, chosen per test) and redirects global fetch('https://api.tavily.com/<path>', ...) to
   `http://127.0.0.1:<port>/<path>` for the duration of `run`. `handlers` maps a pathname to a
   function (parsedBody) => { status, body: object }. */
async function withTavilyStandIn(handlers, run) {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      received.push({ path: req.url, body });
      const handler = handlers[req.url];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no fixture route' }));
        return;
      }
      const { status, body: responseBody } = handler(body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(url);
    return realFetch(`http://127.0.0.1:${port}${u.pathname}`, init);
  };

  try {
    await withEnv({ TAVILY_API_KEY: 'test-key' }, () => run(received));
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
}

// ── searchWeb: real-shaped success ──────────────────────────────────────────────────────────

test('searchWeb maps title/url/domain/snippet/publishedDate from the real Tavily Search shape', async () => {
  await withTavilyStandIn(
    {
      '/search': body => ({
        status: 200,
        body: {
          query: body.query,
          results: [
            {
              title: 'Economy of Guyana - Wikipedia',
              url: 'https://en.wikipedia.org/wiki/Economy_of_Guyana',
              content: 'GDP growth of 10.3% in 2025.',
              score: 0.95,
              raw_content: null,
              id: 'abc-00',
              published_date: 'Mon, 09 Mar 2026 12:00:00 GMT',
            },
          ],
          response_time: 1.2,
          request_id: 'req-1',
        },
      }),
    },
    async received => {
      const results = await searchWeb('Guyana GDP growth', null, null);
      assert.equal(results.length, 1);
      const [w] = results;
      assert.equal(w.title, 'Economy of Guyana - Wikipedia');
      assert.equal(w.url, 'https://en.wikipedia.org/wiki/Economy_of_Guyana');
      assert.equal(w.domain, 'en.wikipedia.org');
      assert.equal(w.snippet, 'GDP growth of 10.3% in 2025.');
      assert.equal(w.publishedDate, 'Mon, 09 Mar 2026 12:00:00 GMT');
      assert.equal(w.extract, null);
      assert.equal(w.id, `W:${sha256Hex('https://en.wikipedia.org/wiki/Economy_of_Guyana')}`);
      assert.equal(w.authorizedBy, ''); // left for the executor to fill in — see webEvidence.ts header
      assert.ok(w.retrievedAt);

      // The real request actually sent — proves query/date params are wired, not just the response mapping.
      const [{ body: sentBody }] = received;
      assert.equal(sentBody.api_key, 'test-key');
      assert.equal(sentBody.query, 'Guyana GDP growth');
      assert.equal(sentBody.start_date, undefined);
      assert.equal(sentBody.end_date, undefined);
    },
  );
});

test('searchWeb passes dateFrom/dateTo through as start_date/end_date', async () => {
  await withTavilyStandIn(
    { '/search': () => ({ status: 200, body: { results: [] } }) },
    async received => {
      await searchWeb('Trinidad economy', '2026-01-01', '2026-08-01');
      const [{ body: sentBody }] = received;
      assert.equal(sentBody.start_date, '2026-01-01');
      assert.equal(sentBody.end_date, '2026-08-01');
    },
  );
});

test('searchWeb omits publishedDate (null) when Tavily does not supply one, as on a general-topic search', async () => {
  await withTavilyStandIn(
    {
      '/search': () => ({
        status: 200,
        body: {
          results: [
            { title: 'GDP report', url: 'https://example.com/gdp', content: 'snippet text', id: 'x' },
          ],
        },
      }),
    },
    async () => {
      const [w] = await searchWeb('gdp', null, null);
      assert.equal(w.publishedDate, null);
    },
  );
});

// ── searchWeb: fails soft ────────────────────────────────────────────────────────────────────

test('searchWeb returns [] (not a throw) on a non-2xx response', async () => {
  await withTavilyStandIn(
    { '/search': () => ({ status: 401, body: { detail: { error: 'Unauthorized' } } }) },
    async () => {
      const results = await searchWeb('anything', null, null);
      assert.deepEqual(results, []);
    },
  );
});

test('searchWeb returns [] (not a throw) on a network error', async () => {
  await withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    try {
      const results = await searchWeb('anything', null, null);
      assert.deepEqual(results, []);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

test('searchWeb returns [] when TAVILY_API_KEY is not configured, with no network call', async () => {
  await withEnv({ TAVILY_API_KEY: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    };
    try {
      const results = await searchWeb('anything', null, null);
      assert.deepEqual(results, []);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── extractWeb: real-shaped success + failed_results ────────────────────────────────────────

test('extractWeb keys results by URL and omits URLs Tavily reports in failed_results', async () => {
  await withTavilyStandIn(
    {
      '/extract': body => ({
        status: 200,
        body: {
          results: body.urls
            .filter(u => u !== 'https://bad.example/nope')
            .map(u => ({ url: u, title: 'T', raw_content: `full text for ${u}`, images: [] })),
          failed_results: body.urls
            .filter(u => u === 'https://bad.example/nope')
            .map(u => ({ url: u, error: 'Failed to fetch url' })),
        },
      }),
    },
    async () => {
      const result = await extractWeb(['https://good.example/a', 'https://bad.example/nope']);
      assert.equal(result.size, 1);
      assert.ok(result.has('https://good.example/a'));
      assert.equal(result.get('https://good.example/a').text, 'full text for https://good.example/a');
      assert.equal(result.has('https://bad.example/nope'), false);
    },
  );
});

test('extractWeb returns an empty Map for an empty urls array, with no network call', async () => {
  await withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.reject(new Error('should not be called'));
    };
    try {
      const result = await extractWeb([]);
      assert.equal(result.size, 0);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ── extractWeb: MAX_EXTRACT_CHARS / MAX_EXTRACT_TOTAL truncation ───────────────────────────

test('extractWeb truncates a single oversized extract to MAX_EXTRACT_CHARS', async () => {
  const { MAX_EXTRACT_CHARS } = await import('./ai/config.ts');
  await withTavilyStandIn(
    {
      '/extract': body => ({
        status: 200,
        body: {
          results: body.urls.map(u => ({ url: u, title: 'T', raw_content: 'x'.repeat(MAX_EXTRACT_CHARS + 5_000) })),
          failed_results: [],
        },
      }),
    },
    async () => {
      const result = await extractWeb(['https://long.example/a']);
      const entry = result.get('https://long.example/a');
      assert.ok(entry);
      assert.equal(entry.chars, MAX_EXTRACT_CHARS);
      assert.equal(entry.text.length, MAX_EXTRACT_CHARS);
    },
  );
});

test('extractWeb caps the SUM across multiple extracts at MAX_EXTRACT_TOTAL, dropping/truncating the rest', async () => {
  const { MAX_EXTRACT_CHARS, MAX_EXTRACT_TOTAL } = await import('./ai/config.ts');
  // Three URLs, each individually under MAX_EXTRACT_CHARS, but whose sum exceeds MAX_EXTRACT_TOTAL.
  const perUrl = Math.min(MAX_EXTRACT_CHARS, Math.ceil(MAX_EXTRACT_TOTAL / 2) + 1);
  const urls = ['https://x.example/1', 'https://x.example/2', 'https://x.example/3'];

  await withTavilyStandIn(
    {
      '/extract': body => ({
        status: 200,
        body: {
          results: body.urls.map(u => ({ url: u, title: 'T', raw_content: 'y'.repeat(perUrl) })),
          failed_results: [],
        },
      }),
    },
    async () => {
      const result = await extractWeb(urls);
      let total = 0;
      for (const { chars } of result.values()) total += chars;
      assert.ok(total <= MAX_EXTRACT_TOTAL, `total ${total} must not exceed MAX_EXTRACT_TOTAL ${MAX_EXTRACT_TOTAL}`);
      // The first URL survives at its full per-URL size; the last URL's extract is truncated
      // shorter than what Tavily actually returned for it, proving the remaining-budget cap
      // (not just the per-URL cap) did the truncating.
      assert.equal(result.get(urls[0]).chars, perUrl);
      assert.ok(result.get(urls[urls.length - 1]).chars < perUrl);
      assert.equal(total, MAX_EXTRACT_TOTAL);
    },
  );
});

// ── extractWeb: fails soft ───────────────────────────────────────────────────────────────────

test('extractWeb returns an empty Map (not a throw) on a non-2xx response', async () => {
  await withTavilyStandIn(
    { '/extract': () => ({ status: 500, body: { error: 'server error' } }) },
    async () => {
      const result = await extractWeb(['https://example.com/a']);
      assert.equal(result.size, 0);
    },
  );
});

test('extractWeb returns an empty Map (not a throw) on a network error', async () => {
  await withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    try {
      const result = await extractWeb(['https://example.com/a']);
      assert.equal(result.size, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
