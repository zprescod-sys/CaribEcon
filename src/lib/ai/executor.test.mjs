/* Tests for executeResearchPlan() (src/lib/ai/executor.ts).
 *
 * No mocks — same standing policy as research.test.mjs/webEvidence.test.mjs/newsArticleFetch.test.mjs.
 * Real local HTTP servers stand in for Tavily, the 'plan' role, and news-article pages; global
 * fetch is monkey-patched to redirect only the specific host/purpose each test cares about (never
 * a blanket redirect of every fetch call, so an accidental extra network call in one path cannot
 * silently get routed into the wrong stand-in and hide a bug). Real deterministic tools
 * (getSeriesEvidence, searchNews, ...) run for real against the real hub — no fixture needed for
 * those, same as research.test.mjs's use of the real buildEvidencePackage().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { executeResearchPlan } from './executor.ts';

/* Sets exactly the given env vars for the duration of `run` (async), restoring each key
   afterward — duplicated per-file on purpose, same convention as webEvidence.test.mjs. */
async function withEnv(vars, run) {
  const saved = {};
  for (const key of Object.keys(vars)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ── Tavily stand-in — only intercepts requests actually addressed to api.tavily.com ──────────
async function withTavilyStandIn(handlers, run) {
  const received = { search: [], extract: [] };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === '/search') received.search.push(body);
      if (req.url === '/extract') received.extract.push(body);
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
    const u = new URL(String(url));
    if (u.hostname === 'api.tavily.com') return realFetch(`http://127.0.0.1:${port}${u.pathname}`, init);
    return realFetch(url, init);
  };

  try {
    await withEnv({ TAVILY_API_KEY: 'test-key' }, () => run(received));
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
}

// ── News-article stand-in — redirects EVERY http(s) fetch to one delayed article route, so the
//    real News Hub's real article URLs (whatever they happen to be) are never actually hit. ────
const ARTICLE_HTML =
  '<!doctype html><html><body><article><p>' +
  'A real, code-fetched article body long enough to clear MIN_USEFUL_CHARS. '.repeat(4) +
  '</p></article></body></html>';

async function withArticleStandIn(delayMs, run) {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount += 1;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ARTICLE_HTML);
    }, delayMs);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(String(url));
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return realFetch(`http://127.0.0.1:${port}/article`, init);
    }
    return realFetch(url, init);
  };

  try {
    await run({ getRequestCount: () => requestCount });
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
}

// ── 'plan' role stand-in — OpenAI-compatible chat-completions shape, same as research.test.mjs ─
function planServer(respond, received) {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      const text = respond(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
    });
  });
}

async function withPlanProvider(respond, run) {
  const received = [];
  const server = planServer(respond, received);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withEnv(
      {
        CARIBECON_PLAN_PROVIDER: 'nebius',
        CARIBECON_PLAN_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => run(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── (1) extract_web authorization: a fabricated/unreachable onStep gets NO Tavily call ────────

test('extract_web with an onStep that never ran makes zero Tavily Extract calls and records a RetrievalMiss', async () => {
  await withTavilyStandIn(
    {
      '/extract': () => ({ status: 200, body: { results: [], failed_results: [] } }),
    },
    async received => {
      const maliciousPlan = {
        question: 'irrelevant — this plan is hand-crafted to skip validateResearchPlan',
        scope: { countries: [], indicators: [], yearFrom: null, yearTo: null },
        steps: [
          {
            id: 'e1',
            tool: 'extract_web',
            onStep: 'ghost-step-that-never-ran',
            maxUrls: 3,
            why: 'fabricated onStep — must not reach Tavily',
          },
        ],
        anticipatedGaps: [],
      };

      const result = await executeResearchPlan(maliciousPlan);

      assert.equal(received.extract.length, 0, 'the stand-in must receive zero /extract requests');
      assert.deepEqual(result.web, []);
      assert.ok(
        result.misses.some(m => m.kind === 'step' && m.detail.includes('ghost-step-that-never-ran')),
        'a RetrievalMiss naming the unauthorized onStep must be recorded',
      );
    },
  );
});

test('extract_web whose onStep names a REAL earlier step id that is not search_web still makes no Tavily call', async () => {
  // A step id that exists in plan.steps (so a naive "does this id exist anywhere" check would
  // wrongly authorize it) but is a get_series step, never a search_web step — the executor's own
  // runtime map is keyed only by ids it actually dispatched AS search_web, so this must still fail.
  await withTavilyStandIn(
    { '/extract': () => ({ status: 200, body: { results: [], failed_results: [] } }) },
    async received => {
      const trickPlan = {
        question: 'irrelevant',
        scope: { countries: [], indicators: [], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'x' },
          { id: 'e1', tool: 'extract_web', onStep: 's1', maxUrls: 2, why: 'onStep names a real but wrong-typed step' },
        ],
        anticipatedGaps: [],
      };

      const result = await executeResearchPlan(trickPlan);

      assert.equal(received.extract.length, 0);
      assert.ok(result.misses.some(m => m.kind === 'step' && m.detail.includes('"s1"')));
    },
  );
});

// ── (2) search_news digest fan-out is genuinely concurrent (timing) ───────────────────────────

test('the news-digest fan-out for a search_news step runs concurrently, not sequentially', async () => {
  const DELAY_MS = 300;
  await withArticleStandIn(DELAY_MS, async ({ getRequestCount }) => {
    const plan = {
      question: 'Recent Guyana news',
      scope: { countries: ['GY'], indicators: [], yearFrom: null, yearTo: null },
      steps: [
        { id: 's1', tool: 'search_news', countries: ['GY'], keywords: [], dateFrom: null, dateTo: null, why: 'x' },
      ],
      anticipatedGaps: [],
    };

    const started = Date.now();
    const result = await executeResearchPlan(plan);
    const elapsedMs = Date.now() - started;

    // MAX_NEWS_DIGESTS is 2 (config.ts) — exactly two article fetches should have been attempted.
    assert.equal(getRequestCount(), 2, 'expected exactly MAX_NEWS_DIGESTS=2 article fetch attempts');
    assert.equal(result.web.filter(w => w.extract).length, 2);

    // Sequential would take ~2 * DELAY_MS (~600ms); genuinely concurrent takes ~1 * DELAY_MS.
    // Generous one-sided bound: well under 2x, comfortably above 1x to rule out a no-op fetch.
    assert.ok(elapsedMs < DELAY_MS * 1.7, `expected concurrent timing (<${DELAY_MS * 1.7}ms), got ${elapsedMs}ms`);
    assert.ok(elapsedMs >= DELAY_MS * 0.8, `expected at least ~1 delay's worth (>=${DELAY_MS * 0.8}ms), got ${elapsedMs}ms`);
  });
});

// ── (3) a failed/unconfigured summarizeArticle keeps the real fetched text ────────────────────

test('when newsExtract is unconfigured, WebEvidence still carries the real fetched text with summary: null', async () => {
  await withEnv({ CARIBECON_NEWSEXTRACT_PROVIDER: undefined, CARIBECON_NEWSEXTRACT_MODEL: undefined }, async () => {
    await withArticleStandIn(20, async () => {
      const plan = {
        question: 'Recent Guyana news',
        scope: { countries: ['GY'], indicators: [], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'search_news', countries: ['GY'], keywords: [], dateFrom: null, dateTo: null, why: 'x' },
        ],
        anticipatedGaps: [],
      };

      const result = await executeResearchPlan(plan);
      const digested = result.web.filter(w => w.authorizedBy === 's1');
      assert.ok(digested.length > 0, 'expected at least one digested article');
      for (const w of digested) {
        assert.ok(w.extract, 'a fetched article must still carry an extract');
        assert.ok(w.extract.text.length > 0, 'the real fetched text must be present');
        assert.equal(w.extract.summary, null, 'summary must be null, never fabricated, when newsExtract is unconfigured');
      }
    });
  });
});

// ── (4) the one-shot re-plan stops after exactly one round, even if misses remain ─────────────

test('re-plans exactly once even when the second round still leaves misses, then stops', async () => {
  const REPLAN_RESPONSE = () =>
    JSON.stringify({
      scope: { countries: ['BS'], indicators: ['gdp_growth'], yearFrom: 1500, yearTo: 1500 },
      steps: [
        {
          id: 's-followup-1',
          tool: 'get_series',
          country: 'BS',
          indicator: 'gdp_growth',
          yearFrom: 1500,
          yearTo: 1500,
          why: 'follow-up probe — deliberately still out of range, to prove no second re-plan happens',
        },
      ],
      anticipatedGaps: [],
    });

  await withPlanProvider(REPLAN_RESPONSE, async planReceived => {
    const firstPlan = {
      question: 'What was Guyana GDP growth in 1500?',
      scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: 1500, yearTo: 1500 },
      steps: [
        { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: 1500, yearTo: 1500, why: 'test' },
      ],
      anticipatedGaps: [],
    };

    const result = await executeResearchPlan(firstPlan);

    // Exactly one plan() call — proves the second round's own remaining miss did not trigger a
    // third pass.
    assert.equal(planReceived.length, 1, 'plan() must be called exactly once for the re-plan');

    const yearMisses = result.misses.filter(m => m.kind === 'years');
    assert.equal(yearMisses.length, 2, 'expected one miss from the original step and one from the re-planned step');
    assert.ok(yearMisses.some(m => m.detail.includes('for GY')));
    assert.ok(yearMisses.some(m => m.detail.includes('for BS')));
    assert.equal(result.data.length, 0);
  });
});

test('no re-plan is attempted when the first pass leaves no misses', async () => {
  let called = false;
  await withPlanProvider(
    () => {
      called = true;
      return JSON.stringify({ scope: { countries: [], indicators: [], yearFrom: null, yearTo: null }, steps: [], anticipatedGaps: [] });
    },
    async () => {
      const plan = {
        question: 'GY GDP growth',
        scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
        steps: [
          { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'test' },
        ],
        anticipatedGaps: [],
      };
      const result = await executeResearchPlan(plan);
      assert.ok(result.data.length > 0, 'a real GY gdp_growth series should exist in the hub');
      assert.equal(result.misses.length, 0);
      assert.equal(called, false, 'plan() must not be called at all when there are no misses');
    },
  );
});

// ── Assembly shape sanity: evidenceMeta covers D:/N:/W: refs, mirroring buildEvidencePackage() ─

test('evidenceMeta covers every D:/N:/W: ref actually in the package, W: using the entry\'s own retrievedAt', async () => {
  await withArticleStandIn(10, async () => {
    const plan = {
      question: 'Recent Guyana news and GDP growth',
      scope: { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null },
      steps: [
        { id: 's1', tool: 'get_series', country: 'GY', indicator: 'gdp_growth', yearFrom: null, yearTo: null, why: 'x' },
        { id: 's2', tool: 'search_news', countries: ['GY'], keywords: [], dateFrom: null, dateTo: null, why: 'x' },
      ],
      anticipatedGaps: [],
    };
    const fixedRetrievedAt = '2026-01-01T00:00:00.000Z';
    const result = await executeResearchPlan(plan, fixedRetrievedAt);

    const refs = new Set(result.evidenceMeta.map(m => m.ref));
    if (result.data.length) assert.ok(refs.has(`D:GY:gdp_growth`));
    for (const n of result.news) assert.ok(refs.has(`N:${n.id}`));
    for (const w of result.web) {
      assert.ok(refs.has(w.id));
      const meta = result.evidenceMeta.find(m => m.ref === w.id);
      assert.equal(meta.retrievedAt, w.retrievedAt);
    }
    const dataMeta = result.evidenceMeta.find(m => m.ref === 'D:GY:gdp_growth');
    assert.equal(dataMeta.retrievedAt, fixedRetrievedAt);
  });
});
