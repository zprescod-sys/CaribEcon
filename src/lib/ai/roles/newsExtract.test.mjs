/* Tests for extractArticleInsights() and verifyImportantFigures() (src/lib/ai/roles/newsExtract.ts).
 *
 * No mocks — same standing policy as interpret.test.mjs and openaiCompatible.test.mjs. Each model
 * call test stands up a real local HTTP server as the stand-in provider and points
 * CARIBECON_NEWSEXTRACT_PROVIDER's connection at it.
 *
 * Two things matter most here, past the earlier prose-summary version: (1) the fail-soft contract
 * — unconfigured, provider error, and unparseable output all resolve to null, never a rejection —
 * and (2) verifyImportantFigures' textPresenceVerified check, which is deliberately weak (proves a
 * number is somewhere in the article, not that it's attached to the right metric/period) and must
 * drop, not merely flag, a figure whose value isn't in the text at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extractArticleInsights, verifyImportantFigures } from './newsExtract.ts';

const SAMPLE_ARTICLE = {
  title: 'Guyana announces new budget allocation',
  text: 'The government of Guyana announced a record budget today, with GDP growth reaching 43.8% in 2024, driven mainly by oil output. Increased allocations were made for infrastructure and healthcare.',
  publishedDate: '2026-08-10',
};

const VALID_RESPONSE = {
  keyClaims: ['Guyana announced a record budget with increased infrastructure and healthcare spending.'],
  importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', country: 'Guyana' }],
  economicDrivers: [
    { driver: 'Oil output', mechanism: 'Higher oil production raises export revenue and GDP.', evidence: 'driven mainly by oil output', confidence: 'high' },
  ],
  relevantContext: ['The budget covers infrastructure and healthcare.'],
  topics: ['fiscal_policy', 'oil'],
};

/* Sets exactly the given env vars for the duration of `run`, restoring each key afterward —
   same helper as interpret.test.mjs, duplicated rather than shared for the same reason: this is
   three lines of setup and keeping it local lets this file run standalone. */
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

/* Stands up a stand-in provider and runs `test_` with the newsExtract role pointed at it.
   `respond` receives the parsed request body and returns either a raw text content string (the
   model's message.content — e.g. a JSON string, or deliberately malformed text), or a
   { status, text } object to simulate a provider error response. */
async function withNewsExtractProvider(respond, test_) {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw);
      received.push(body);
      const result = respond(body);
      if (result && typeof result === 'object' && 'status' in result) {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: result.text ?? 'error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: result }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    await withEnv(
      {
        CARIBECON_NEWSEXTRACT_PROVIDER: 'nebius',
        CARIBECON_NEWSEXTRACT_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => test_(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── Not configured — returns null, does NOT throw ───────────────────────────────────────────

test('returns null, with no network call, when the role is unconfigured', async () => {
  await withEnv(
    { CARIBECON_NEWSEXTRACT_PROVIDER: undefined, CARIBECON_NEWSEXTRACT_MODEL: undefined },
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(result, null);
    },
  );
});

// ── A real successful structured call ───────────────────────────────────────────────────────

test('a successful call returns structured insights, with a real figure verified present', async () => {
  await withNewsExtractProvider(
    () => JSON.stringify(VALID_RESPONSE),
    async received => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.deepEqual(result.keyClaims, VALID_RESPONSE.keyClaims);
      assert.deepEqual(result.relevantContext, VALID_RESPONSE.relevantContext);
      assert.deepEqual(result.topics, VALID_RESPONSE.topics);
      assert.deepEqual(result.economicDrivers, VALID_RESPONSE.economicDrivers);
      assert.deepEqual(result.importantFigures, [
        { metric: 'GDP growth', value: '43.8%', period: '2024', country: 'GY', textPresenceVerified: true },
      ]);

      const [req] = received;
      assert.equal(req.temperature, 0);
      assert.equal(req.messages[0].role, 'system');
      assert.equal(req.messages[1].role, 'user');
      assert.ok(req.messages[1].content.includes(SAMPLE_ARTICLE.title));
      assert.ok(req.messages[1].content.includes(SAMPLE_ARTICLE.text));
      // The caller-known article-level metadata (url, source, articleId) is never asked of the
      // model and never sent as input either — the caller attaches it deterministically. Per-figure
      // country IS asked (as output only, see below) — a distinct, deliberate exception.
      assert.ok(!req.messages[1].content.includes('http'), 'no URL should be sent as input either — not needed for extraction');
    },
  );
});

test("a figure the model claims but that isn't in the article text is dropped, not merely flagged", async () => {
  const responseWithFabrication = {
    ...VALID_RESPONSE,
    importantFigures: [
      { metric: 'GDP growth', value: '43.8%', period: '2024' }, // real — in SAMPLE_ARTICLE.text
      { metric: 'Inflation', value: '91.2%', period: '2024' }, // fabricated — never in the text
    ],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(responseWithFabrication),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(result.importantFigures.length, 1, 'the fabricated figure must be dropped, not kept with a false flag');
      assert.equal(result.importantFigures[0].metric, 'GDP growth');
      assert.equal(result.importantFigures[0].textPresenceVerified, true);
    },
  );
});

test('the model attempting to emit url/source/articleId is silently ignored, not a parse failure', async () => {
  const responseWithExtraFields = {
    ...VALID_RESPONSE,
    url: 'https://fabricated-by-model.example.com',
    source: 'Model-Invented Source',
    articleId: 'model-invented-id',
  };
  await withNewsExtractProvider(
    () => JSON.stringify(responseWithExtraFields),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.ok(result, 'extra unrequested fields must not break parsing');
      assert.deepEqual(Object.keys(result).sort(), [
        'economicDrivers',
        'importantFigures',
        'keyClaims',
        'relevantContext',
        'topics',
      ]);
    },
  );
});

// ── Structural coercion — malformed entries dropped, not the whole response ────────────────

test('a malformed importantFigures/economicDrivers entry is dropped; the rest of the response survives', async () => {
  const responseWithBadEntries = {
    keyClaims: ['A real claim.'],
    importantFigures: [
      { metric: 'GDP growth', value: '43.8%', period: '2024' }, // valid
      { metric: 'Missing value field', period: '2024' }, // invalid — dropped
    ],
    economicDrivers: [
      { driver: 'Oil output', mechanism: 'x', evidence: 'y', confidence: 'high' }, // valid
      { driver: 'Missing mechanism' }, // invalid — dropped
    ],
    relevantContext: [],
    topics: ['oil'],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(responseWithBadEntries),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(result.importantFigures.length, 1);
      assert.equal(result.economicDrivers.length, 1);
      assert.equal(result.keyClaims.length, 1);
    },
  );
});

// ── Per-figure country: resolved through resolveCountry(), never passed through raw ───────

test('a figure country the model writes as a full name resolves to the real hub code', async () => {
  const response = {
    ...VALID_RESPONSE,
    importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', country: 'Guyana' }],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(response),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(result.importantFigures[0].country, 'GY');
    },
  );
});

test('an unrecognized figure country string becomes null, not passed through raw', async () => {
  const response = {
    ...VALID_RESPONSE,
    importantFigures: [{ metric: 'GDP growth', value: '43.8%', period: '2024', country: 'Freedonia' }],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(response),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(
        result.importantFigures[0].country,
        null,
        'an unresolved country string must never reach the Evidence Compiler raw — it would silently never match a hub country key',
      );
    },
  );
});

test('a figure with no country field, or an explicit null, resolves to null rather than a crash', async () => {
  const response = {
    ...VALID_RESPONSE,
    importantFigures: [
      { metric: 'GDP growth', value: '43.8%', period: '2024' }, // field omitted entirely
      { metric: 'Inflation', value: '4.1%', period: '2024', country: null }, // explicit null
    ],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(response),
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      // Both figures are real text in SAMPLE_ARTICLE.text? No — only GDP growth 43.8% is; the
      // Inflation figure must survive coercion but can still be dropped by textPresenceVerified.
      // What matters here is coercion never throws over a missing/null country either way.
      assert.ok(result, 'a missing or explicitly null country must not break parsing');
      const gdp = result.importantFigures.find(f => f.metric === 'GDP growth');
      assert.equal(gdp.country, null);
    },
  );
});

test("a multi-country article: each figure keeps the model's OWN per-figure country, not a shared article-level default", async () => {
  const article = {
    title: 'Regional oil roundup',
    text: 'Guyana posted GDP growth of 19.3% in 2025, driven by offshore oil. By contrast, Trinidad and Tobago contracted -0.8% over the same period as its gas sector matured.',
    publishedDate: '2026-08-10',
  };
  const response = {
    ...VALID_RESPONSE,
    importantFigures: [
      { metric: 'GDP growth', value: '19.3%', period: '2025', country: 'Guyana' },
      { metric: 'GDP growth', value: '-0.8%', period: '2025', country: 'Trinidad and Tobago' },
    ],
  };
  await withNewsExtractProvider(
    () => JSON.stringify(response),
    async () => {
      const result = await extractArticleInsights(article);
      const byValue = Object.fromEntries(result.importantFigures.map(f => [f.value, f.country]));
      assert.equal(byValue['19.3%'], 'GY');
      assert.equal(byValue['-0.8%'], 'TT');
    },
  );
});

// ── Fail-soft: a provider error returns null, not a throw ──────────────────────────────────

test('a provider error (500) returns null instead of throwing', async () => {
  await withNewsExtractProvider(
    () => ({ status: 500, text: 'internal error' }),
    async () => {
      await assert.doesNotReject(async () => {
        const result = await extractArticleInsights(SAMPLE_ARTICLE);
        assert.equal(result, null);
      });
    },
  );
});

// ── Fail-soft: unparseable JSON returns null ────────────────────────────────────────────────

test('a non-JSON response returns null, not a throw', async () => {
  await withNewsExtractProvider(
    () => 'This is not JSON at all, just prose the model wrote instead.',
    async () => {
      const result = await extractArticleInsights(SAMPLE_ARTICLE);
      assert.equal(result, null);
    },
  );
});

// ── verifyImportantFigures — pure function, no model call ──────────────────────────────────

test('verifyImportantFigures: a real, present value is verified; sign and precision are handled', () => {
  const text = 'Inflation declined 3.88 percentage points to 4.1% in the second quarter.';
  const figures = [
    { metric: 'Inflation change', value: '-3.88', period: 'Q2' }, // signed, text has it unsigned
    { metric: 'Inflation level', value: '4.1%', period: 'Q2' },
  ];
  const result = verifyImportantFigures(figures, text);
  assert.equal(result.length, 2);
  assert.ok(result.every(f => f.textPresenceVerified === true));
});

test('verifyImportantFigures: a value nowhere in the text is dropped entirely', () => {
  const text = 'Inflation declined 3.88 percentage points to 4.1% in the second quarter.';
  const figures = [
    { metric: 'GDP growth', value: '91.2%', period: '2024' }, // not in the text at all
  ];
  const result = verifyImportantFigures(figures, text);
  assert.equal(result.length, 0);
});

test('verifyImportantFigures: an unparseable value string is dropped, not a crash', () => {
  const text = 'Inflation declined 3.88 percentage points.';
  const figures = [{ metric: 'Vague', value: 'a lot', period: '2024' }];
  const result = verifyImportantFigures(figures, text);
  assert.equal(result.length, 0);
});
