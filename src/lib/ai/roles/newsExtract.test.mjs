/* Tests for summarizeArticle() (src/lib/ai/roles/newsExtract.ts).
 *
 * No mocks — same standing policy as interpret.test.mjs and openaiCompatible.test.mjs. Each test
 * stands up a real local HTTP server as the stand-in provider and points
 * CARIBECON_NEWSEXTRACT_PROVIDER's connection at it.
 *
 * The behaviour under test that matters most here is the fail-soft contract: unlike interpret(),
 * summarizeArticle() must never throw — unconfigured, provider error, and empty output all
 * resolve to null, not a rejection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { summarizeArticle } from './newsExtract.ts';

const SAMPLE_ARTICLE = {
  title: 'Guyana announces new budget allocation',
  url: 'https://example.com/guyana-budget',
  text: 'The government of Guyana announced a record budget today, with increased allocations for infrastructure and healthcare.',
  publishedDate: '2026-08-10',
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
   `respond` receives the parsed request body and returns either a raw text content string, or a
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
      const result = await summarizeArticle(SAMPLE_ARTICLE);
      assert.equal(result, null);
    },
  );
});

// ── A real successful call ──────────────────────────────────────────────────────────────────

test('a successful call returns the trimmed summary text', async () => {
  await withNewsExtractProvider(
    () => '  Guyana announced a record budget with more spending on infrastructure and healthcare.  \n',
    async received => {
      const result = await summarizeArticle(SAMPLE_ARTICLE);
      assert.equal(
        result,
        'Guyana announced a record budget with more spending on infrastructure and healthcare.',
      );
      const [req] = received;
      assert.equal(req.temperature, 0);
      assert.equal(req.messages[0].role, 'system');
      assert.ok(req.messages[0].content.includes('short, factual summary'));
      assert.equal(req.messages[1].role, 'user');
      assert.ok(req.messages[1].content.includes(SAMPLE_ARTICLE.title));
      assert.ok(req.messages[1].content.includes(SAMPLE_ARTICLE.text));
    },
  );
});

// ── Fail-soft: a provider error returns null, not a throw ──────────────────────────────────

test('a provider error (500) returns null instead of throwing', async () => {
  await withNewsExtractProvider(
    () => ({ status: 500, text: 'internal error' }),
    async () => {
      await assert.doesNotReject(async () => {
        const result = await summarizeArticle(SAMPLE_ARTICLE);
        assert.equal(result, null);
      });
    },
  );
});

// ── Fail-soft: empty/whitespace-only model output is treated as null ───────────────────────

test('an empty response is treated as null, not an empty-string summary', async () => {
  await withNewsExtractProvider(
    () => '   \n  ',
    async () => {
      const result = await summarizeArticle(SAMPLE_ARTICLE);
      assert.equal(result, null);
    },
  );
});
