/* Tests for interpret() (src/lib/ai/roles/interpret.ts).
 *
 * No mocks — same standing policy as openaiCompatible.test.mjs. Each test stands up a real local
 * HTTP server as the stand-in provider and points CARIBECON_INTERPRET_PROVIDER's connection at
 * it, so a test asserting "the model's slug resolves to a real hub record" is exercising the
 * ACTUAL canonicaliseIntent integration, not a mocked one that could silently drift from it.
 *
 * Real hub codes/slugs (GY, TT, gdp_growth, inflation) — same convention as askTools.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { interpret, InterpretNotConfiguredError, InterpretParseError } from './interpret.ts';

/* Sets exactly the given env vars for the duration of `run`, restoring each key afterward —
   same helper as config.test.mjs, duplicated rather than shared: it is three lines of setup and
   this keeps each test file able to run standalone. */
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

/* Stands up a stand-in provider and runs `test` with interpret's role pointed at it. `respond`
   receives the parsed request body and returns the assistant's raw text content. */
async function withInterpretProvider(respond, test_) {
  const received = [];
  const server = createServer((req, res) => {
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    await withEnv(
      {
        CARIBECON_INTERPRET_PROVIDER: 'nebius',
        CARIBECON_INTERPRET_MODEL: 'test-model',
        NEBIUS_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        NEBIUS_API_KEY: 'test-key',
      },
      () => test_(received),
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

// ── Not configured — fails closed before any network call ──────────────────────────────────

test('throws InterpretNotConfiguredError, with no network call, when the role is unconfigured', async () => {
  await withEnv(
    { CARIBECON_INTERPRET_PROVIDER: undefined, CARIBECON_INTERPRET_MODEL: undefined },
    async () => {
      await assert.rejects(() => interpret('What was GDP growth in Guyana?'), InterpretNotConfiguredError);
    },
  );
});

// ── The request actually sent ───────────────────────────────────────────────────────────────

test('sends the question as user content and embeds the real hub catalog in the system prompt', async () => {
  await withInterpretProvider(
    () => JSON.stringify({ questionType: 'indicator', countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null, newsKeywords: [] }),
    async received => {
      await interpret('What was GDP growth in Guyana?');
      const [req] = received;
      assert.equal(req.messages[1].role, 'user');
      assert.equal(req.messages[1].content, 'What was GDP growth in Guyana?');
      assert.equal(req.messages[0].role, 'system');
      // Real hub data, not a placeholder — proves listCountries()/listIndicators() were actually called.
      assert.ok(req.messages[0].content.includes('GY=Guyana'));
      assert.ok(req.messages[0].content.includes('gdp_growth='));
      assert.equal(req.temperature, 0);
    },
  );
});

// ── A clean response resolves through the real canonicaliseIntent ──────────────────────────

test('a well-formed model response resolves to a real hub intent, via the actual canonicaliseIntent', async () => {
  await withInterpretProvider(
    () => JSON.stringify({
      questionType: 'comparison', countries: ['Guyana', 'Trinidad'], indicators: ['gdp_growth'],
      yearFrom: 2020, yearTo: 2023, newsKeywords: [],
    }),
    async () => {
      const { intent, misses } = await interpret('Compare GDP growth in Guyana and Trinidad since 2020');
      assert.deepEqual(intent, {
        questionType: 'comparison',
        countries: ['GY', 'TT'], // resolved from free-text names, not codes — proves real resolution ran
        indicators: ['gdp_growth'],
        yearFrom: 2020,
        yearTo: 2023,
        newsKeywords: [],
      });
      assert.equal(misses.length, 0);
    },
  );
});

test('a hallucinated country name is stripped and recorded as a miss, never invented into the intent', async () => {
  await withInterpretProvider(
    () => JSON.stringify({
      questionType: 'indicator', countries: ['Atlantis'], indicators: ['gdp_growth'],
      yearFrom: null, yearTo: null, newsKeywords: [],
    }),
    async () => {
      const { intent, misses } = await interpret('GDP growth in Atlantis?');
      assert.deepEqual(intent.countries, []);
      assert.ok(misses.some(m => m.kind === 'country' && m.detail.includes('Atlantis')));
    },
  );
});

// ── Robust JSON extraction ──────────────────────────────────────────────────────────────────

test('a response wrapped in a ```json fence is still parsed correctly', async () => {
  await withInterpretProvider(
    () => '```json\n' + JSON.stringify({ questionType: 'indicator', countries: ['GY'], indicators: ['inflation'], yearFrom: null, yearTo: null, newsKeywords: [] }) + '\n```',
    async () => {
      const { intent } = await interpret('inflation in Guyana');
      assert.deepEqual(intent.countries, ['GY']);
      assert.deepEqual(intent.indicators, ['inflation']);
    },
  );
});

test('a JSON object preceded by stray prose is still found and parsed', async () => {
  await withInterpretProvider(
    () => 'Here is the JSON you requested: ' + JSON.stringify({ questionType: 'news', countries: ['GY'], indicators: [], yearFrom: null, yearTo: null, newsKeywords: ['budget'] }),
    async () => {
      const { intent } = await interpret('news about the Guyana budget');
      assert.equal(intent.questionType, 'news');
      assert.deepEqual(intent.newsKeywords, ['budget']);
    },
  );
});

// ── A genuinely unparseable response is a loud, distinct failure ──────────────────────────

test('a non-JSON response raises InterpretParseError, never a silently empty intent', async () => {
  await withInterpretProvider(
    () => 'I am not able to help with that.',
    async () => {
      await assert.rejects(
        () => interpret('anything'),
        err => err instanceof InterpretParseError && err.rawText === 'I am not able to help with that.',
      );
    },
  );
});
