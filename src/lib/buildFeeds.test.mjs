import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchFeed, mapWithConcurrency } from '../../scripts/build-feeds.mjs';

test('mapWithConcurrency caps active work and preserves input order', async () => {
  const delays = [30, 5, 20, 1, 10];
  let active = 0;
  let maxActive = 0;

  const results = await mapWithConcurrency(delays, 2, async (delay, index) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    return `result-${index}`;
  });

  assert.equal(maxActive, 2);
  assert.deepEqual(results, [
    'result-0',
    'result-1',
    'result-2',
    'result-3',
    'result-4',
  ]);
});

test('mapWithConcurrency rejects an invalid limit', async () => {
  await assert.rejects(
    mapWithConcurrency([1], 0, async (value) => value),
    /positive integer/,
  );
});

test('fetchFeed aborts a stalled attempt at its configured deadline', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let attempts = 0;
  globalThis.fetch = async (_url, { signal }) => {
    attempts++;
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };

  await assert.rejects(
    fetchFeed('https://example.test/feed.xml', false, 1, 20),
    (error) => error?.name === 'TimeoutError',
  );
  assert.equal(attempts, 1);
});

test('fetchFeed restores the previous TLS setting after an insecure failure', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTLS = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalTLS === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTLS;
  });

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
  globalThis.fetch = async () => {
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
    throw new Error('simulated TLS failure');
  };

  await assert.rejects(
    fetchFeed('https://example.test/feed.xml', true, 1, 20),
    /simulated TLS failure/,
  );
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '1');
});
