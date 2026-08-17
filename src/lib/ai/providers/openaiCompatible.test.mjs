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
