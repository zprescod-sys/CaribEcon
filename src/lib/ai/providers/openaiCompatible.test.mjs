/* Tests for the OpenAI-compatible adapter (src/lib/ai/providers/openaiCompatible.ts).
 *
 * No mocks — consistent with this repo's standing policy (api/research.test.mjs's header).
 * Each test stands up a REAL local HTTP server standing in for a provider and points callModel
 * at it, so the assertions are about what actually crossed the wire and what the adapter
 * actually did with a real response, not about a mocked interface agreeing with itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { callModel, ProviderCallError } from './openaiCompatible.ts';

const CONNECTION = { name: 'nebius', baseUrl: '', apiKey: 'test-key' };

/* Starts a stand-in provider. `respond` receives the parsed request body and returns
   { status, body } — body may be a string to exercise the non-JSON path. */
async function withProvider(respond, run) {
  const received = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => (raw += chunk));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const { status = 200, body = {} } = respond(received[received.length - 1].body) ?? {};
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' });
      res.end(payload);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run({ ...CONNECTION, baseUrl: `http://127.0.0.1:${server.address().port}` }, received);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const OK_BODY = {
  choices: [{ message: { content: 'hello from the model' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
};

// ── The request actually sent ───────────────────────────────────────────────────────────────

test('sends the model, messages, Authorization bearer, and POSTs to /chat/completions', async () => {
  await withProvider(
    () => ({ body: OK_BODY }),
    async (connection, received) => {
      await callModel(connection, 'test-model', [{ role: 'user', content: 'ping' }]);
      const [req] = received;
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer test-key');
      assert.equal(req.body.model, 'test-model');
      assert.deepEqual(req.body.messages, [{ role: 'user', content: 'ping' }]);
    },
  );
});

test('a trailing slash on baseUrl does not produce a double slash in the request path', async () => {
  await withProvider(
    () => ({ body: OK_BODY }),
    async (connection, received) => {
      await callModel({ ...connection, baseUrl: `${connection.baseUrl}/` }, 'm', [{ role: 'user', content: 'x' }]);
      assert.equal(received[0].url, '/chat/completions');
    },
  );
});

test('temperature and maxTokens are only sent when explicitly provided', async () => {
  await withProvider(
    () => ({ body: OK_BODY }),
    async (connection, received) => {
      await callModel(connection, 'm', [{ role: 'user', content: 'x' }]);
      assert.equal(received[0].body.temperature, undefined);
      assert.equal(received[0].body.max_tokens, undefined);

      await callModel(connection, 'm', [{ role: 'user', content: 'x' }], { temperature: 0.2, maxTokens: 500 });
      assert.equal(received[1].body.temperature, 0.2);
      assert.equal(received[1].body.max_tokens, 500);
    },
  );
});

// ── Parsing a real success response ─────────────────────────────────────────────────────────

test('extracts text, finishReason and usage from a standard success response', async () => {
  await withProvider(
    () => ({ body: OK_BODY }),
    async connection => {
      const result = await callModel(connection, 'm', [{ role: 'user', content: 'x' }]);
      assert.deepEqual(result, {
        text: 'hello from the model',
        finishReason: 'stop',
        usage: { promptTokens: 12, completionTokens: 4 },
      });
    },
  );
});

// Real capture: MiniMax-M3 answering the 'plan' role prompt (2026-08-18, api/ask.ts live test).
// The <think> trace itself contains a stray `{"cmd":"final",...}` JSON-looking fragment mid-thought
// before the model settles on its real answer — this broke every caller's brace-matching JSON
// extraction until callModel started stripping <think> blocks centrally. Kept verbatim (not
// trimmed to a minimal repro) because the exact shape — an embedded JSON fragment inside the
// reasoning, not just prose — is what made this bug non-obvious.
const REAL_MINIMAX_THINK_LEAK = `<think>
We need output only JSON. Need plan. Need interpret latest news, oil sector, relate GDP growth. Structured context null years. Need fewest steps. We can search news and series perhaps parallel? Step order deterministic executor. Need get GDP growth maybe recent years. Since null years and latest news, determine latest first via search news, perhaps date bounds null. Then web search official/context, extract. Need perhaps series yearFrom? Recent GDP growth, maybe 2022-current. But cannot know. Tools allow null. We can call get_series country GY indicator gdp_growth null null. Search news Guyana oil GDP growth keywords. Search web query official Guyana oil latest production government GDP IMF perhaps dates null. Then extract s4. Do we need both news and web? Question latest economic news; search_news sufficient, and extract web to details. Could use search news, then maybe extract news URLs? But extract_web must follow search_web, not search_news. So include search_web. Fewest 3: s1 get GDP, s3 search news, s4 search web and s5 extract s4. Is order ideally s1 and s3 then s4 based on? Plans often search broad and series. But we can structure s1 series first, s2 news, s3 web then extract. Yet "latest" and relation. Search news can identify latest. Web search official sources. Sequence perhaps s1, s2, s3, s4. Does search_web query need exact dates? no.

Need anticipatedGaps concise. Potential lack of same-period GDP breakdown/attribution; oil news may discuss announced projects not actual output; geopolitical/local issues. But don't invent. Say "The news may not quantify oil-sector contribution to GDP..." and "Series and news publication dates may not align with latest quarter". That's expected evidence gaps.

Country GY. Indicator gdp_growth. year null. Search dates null because latest. Keywords maybe "Guyana oil GDP growth" exactly. But separate query maybe "Guyana oil sector latest economic news production exports

{"cmd":"final","content":"{\\"answer\\":\\"...\\"}"}

sector. Should we search specific? Search_news keywords can be ["Guyana oil GDP growth"] as intent. Could include "oil production economy". Search web query "Guyana latest oil sector economic news GDP growth production 2025 2026" This risks future. Current date? System doesn't give. We need not assert. Search query perhaps "latest Guyana oil sector economic news GDP growth oil production official". That's fine.

get_series no date null means full series. Good.

Could add compare_series? No, no comparison asked. Extract web maxUrls maybe 8. Search_news itself may return articles but to extract need web. This is 4 steps. Could omit s1? Need relate recent GDP, data useful. Yes.

Need JSON valid. No prose. Anticipated gaps no unsupported facts. Ensure extract onStep s3, not search news.

Maybe order: s1 get series, s2 search_news, s3 search_web, s4 extract. The user asks "latest economic news on oil sector, and how relates to recent GDP growth." Series full gives historical. Search news. Search web official sources. Extract pages. This is apt. Maybe latest news only could use search_news and no web, but news tool likely gives excerpts. Yet relation requires contextual evidence. Search web and extraction.

Need no question field. Let's formulate.
</think>
{"scope":{"countries":["GY"],"indicators":["gdp_growth"],"yearFrom":null,"yearTo":null},"steps":[{"id":"s1","tool":"get_series","country":"GY","indicator":"gdp_growth","yearFrom":null,"yearTo":null,"why":"x"}],"anticipatedGaps":["x"]}`;

test('a <think> reasoning block is stripped from text, even when it contains a stray JSON-looking fragment', async () => {
  await withProvider(
    () => ({ body: { choices: [{ message: { content: REAL_MINIMAX_THINK_LEAK }, finish_reason: 'stop' }] } }),
    async connection => {
      const result = await callModel(connection, 'm', [{ role: 'user', content: 'x' }]);
      assert.ok(!result.text.includes('<think>'), 'no <think> tag should survive');
      assert.ok(!result.text.includes('"cmd":"final"'), 'the stray mid-thought JSON fragment should not survive');
      // The real answer must parse clean on its own, since callModel's whole job here is leaving
      // exactly one well-formed JSON object behind for parseModelJson's callers.
      const parsed = JSON.parse(result.text);
      assert.deepEqual(parsed.scope, { countries: ['GY'], indicators: ['gdp_growth'], yearFrom: null, yearTo: null });
    },
  );
});

test('an unterminated <think> block (cut off mid-reasoning) is left untouched, not guessed at', async () => {
  await withProvider(
    () => ({ body: { choices: [{ message: { content: '<think>still reasoning, never closed' }, finish_reason: 'length' }] } }),
    async connection => {
      const result = await callModel(connection, 'm', [{ role: 'user', content: 'x' }]);
      assert.equal(result.text, '<think>still reasoning, never closed');
    },
  );
});

test('usage is null when the provider omits it, not a crash', async () => {
  await withProvider(
    () => ({ body: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } }),
    async connection => {
      const result = await callModel(connection, 'm', [{ role: 'user', content: 'x' }]);
      assert.equal(result.usage, null);
    },
  );
});

// ── Failure mapping — every failure becomes a ProviderCallError, never an unhandled throw ──

test('a non-2xx response raises ProviderCallError carrying the status', async () => {
  await withProvider(
    () => ({ status: 401, body: { error: { message: 'invalid api key' } } }),
    async connection => {
      await assert.rejects(
        () => callModel(connection, 'm', [{ role: 'user', content: 'x' }]),
        (err) => {
          assert.ok(err instanceof ProviderCallError);
          assert.equal(err.status, 401);
          assert.equal(err.message, 'invalid api key');
          return true;
        },
      );
    },
  );
});

test('an error body that is a bare string is still surfaced, not swallowed', async () => {
  await withProvider(
    () => ({ status: 400, body: { error: 'bad request' } }),
    async connection => {
      await assert.rejects(
        () => callModel(connection, 'm', [{ role: 'user', content: 'x' }]),
        err => err.message === 'bad request',
      );
    },
  );
});

test('a non-JSON response raises ProviderCallError rather than throwing a parse error', async () => {
  await withProvider(
    () => ({ status: 502, body: '<html>gateway error</html>' }),
    async connection => {
      await assert.rejects(
        () => callModel(connection, 'm', [{ role: 'user', content: 'x' }]),
        err => err instanceof ProviderCallError && err.status === 502,
      );
    },
  );
});

test('a 200 with no message content is refused rather than returned as an empty answer', async () => {
  await withProvider(
    () => ({ body: { choices: [{ finish_reason: 'stop' }] } }),
    async connection => {
      await assert.rejects(
        () => callModel(connection, 'm', [{ role: 'user', content: 'x' }]),
        err => err instanceof ProviderCallError && err.status === 200,
      );
    },
  );
});

test('an unreachable provider is a ProviderCallError with a null status, not an unhandled throw', async () => {
  // Port 1 on loopback: nothing listens, connection is refused immediately.
  await assert.rejects(
    () => callModel({ ...CONNECTION, baseUrl: 'http://127.0.0.1:1' }, 'm', [{ role: 'user', content: 'x' }]),
    err => err instanceof ProviderCallError && err.status === null,
  );
});

test('a slow provider is refused at the configured timeout, not left hanging', async () => {
  const server = createServer(() => {
    /* deliberately never responds */
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const connection = { ...CONNECTION, baseUrl: `http://127.0.0.1:${server.address().port}` };
    const startedAt = Date.now();
    await assert.rejects(
      () => callModel(connection, 'm', [{ role: 'user', content: 'x' }], { timeoutMs: 200 }),
      err => err instanceof ProviderCallError && err.message.includes('200ms'),
    );
    assert.ok(Date.now() - startedAt < 5_000, 'must not wait for the default timeout when one was given');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
