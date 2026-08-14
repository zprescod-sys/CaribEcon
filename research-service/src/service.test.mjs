/* Contract tests for the Phase 0b service core (service.mjs).
 *
 * These run without the MCP SDK, without a transport and without a network — which is the point
 * of keeping research() a plain function. The adapter is covered separately by
 * mcpServer.test.mjs, which drives a real stdio JSON-RPC session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { research, InvalidRequestError, DEFAULT_RUNTIME } from './service.mjs';

test('returns the agreed Phase 0b structured result', async () => {
  assert.deepEqual(await research({ question: 'ping' }), {
    ok: true,
    service: 'caribecon-research',
    runtime: 'noinfra',
  });
});

test('runtime is injected by the caller, never read from the environment', async () => {
  // The §5.3 portability rule in test form: the same service code reports whichever runtime its
  // adapter passes, so moving it off NoInfra needs no edit here.
  const result = await research({ question: 'ping' }, { runtime: 'vercel' });
  assert.equal(result.runtime, 'vercel');
  assert.equal(DEFAULT_RUNTIME, 'noinfra');
});

test('a missing, empty or whitespace-only question is rejected, never silently answered', async () => {
  // Load-bearing for the spike: without this, a green end-to-end ping could not distinguish
  // "the pipe carried my question" from "the pipe carried nothing and the stub answered anyway".
  for (const bad of [undefined, {}, { question: '' }, { question: '   ' }, { question: 42 }]) {
    await assert.rejects(
      () => research(bad === undefined ? undefined : bad),
      InvalidRequestError,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('the stub asserts no facts — no figures, citations or prose in the response', async () => {
  // ARCHITECTURE.md §2.1: nothing may produce what the deterministic core has not retrieve.
  // Phase 0b retrieves nothing, so its response must stay free of anything fact-shaped.
  const result = await research({ question: 'What was Guyana GDP growth in 2024?' });
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'runtime', 'service']);
  assert.equal(JSON.stringify(result).match(/\d+\.\d+/), null, 'no figure-shaped values');
});
