/* Regression test for api/research.ts — AUTH GATE ONLY (plan §9 Phase 1: "protect... the
 * legacy api/research.ts path with regression checks", and CLAUDE.md: this file is frozen for
 * the buildathon's duration).
 *
 * Deliberately does NOT exercise the tool loop or synthesis: that requires a real
 * ANTHROPIC_API_KEY and spends tokens on Zeke's personal card on every run, which contradicts
 * the point of a test suite he can run freely and often. Every case below returns before the
 * file's `new Anthropic()` call (api/research.ts:294) — confirmed by reading the source: the
 * token check (258-267) and the ANTHROPIC_API_KEY presence check (268-270) both come before
 * the client is constructed. Anthropic is never called, so no key is required to run this file
 * and CI/local runs never touch the network.
 *
 * If a future edit moves client construction earlier than the auth checks, these tests would
 * start requiring network access — that would be a regression this file is meant to catch, not
 * something to route around by mocking the SDK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import research from './research.ts';

const ORIGINAL_TOKEN = process.env.CARIBECON_RESEARCH_TOKEN;
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) delete process.env.CARIBECON_RESEARCH_TOKEN;
  else process.env.CARIBECON_RESEARCH_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
}

const post = (question, headers = {}) =>
  research.fetch(
    new Request('http://localhost/api/research', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ question }),
    }),
  );

test('fails closed with 503 when CARIBECON_RESEARCH_TOKEN is not configured', async () => {
  delete process.env.CARIBECON_RESEARCH_TOKEN;
  try {
    const res = await post('what is GDP growth in Guyana?');
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'not_configured');
  } finally {
    restoreEnv();
  }
});

test('rejects a missing or wrong X-CaribEcon-Token with 401 once a token is configured', async () => {
  process.env.CARIBECON_RESEARCH_TOKEN = 'test-token-do-not-use';
  try {
    const missing = await post('question', {});
    assert.equal(missing.status, 401);

    const wrong = await post('question', { 'X-CaribEcon-Token': 'wrong-token' });
    assert.equal(wrong.status, 401);
  } finally {
    restoreEnv();
  }
});

test('with a valid token but no ANTHROPIC_API_KEY, fails closed with 503 before any provider call', async () => {
  process.env.CARIBECON_RESEARCH_TOKEN = 'test-token-do-not-use';
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await post('question', { 'X-CaribEcon-Token': 'test-token-do-not-use' });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'not_configured');
    assert.match(body.message, /ANTHROPIC_API_KEY/);
  } finally {
    restoreEnv();
  }
});

test('a non-POST method is rejected before any auth check runs', async () => {
  const res = await research.fetch(new Request('http://localhost/api/research', { method: 'GET' }));
  assert.equal(res.status, 405);
});

test('OPTIONS preflight returns 204 with CORS headers, no auth required', async () => {
  const res = await research.fetch(new Request('http://localhost/api/research', { method: 'OPTIONS' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(res.headers.get('Access-Control-Allow-Headers'), 'Content-Type, X-CaribEcon-Token');
});
