// Regression tests for the shared AI-endpoint guard (src/lib/apiGuard.ts) — auth, rate limit,
// CORS. Copied logic from api/research.ts; these tests pin the copy's behavior so it can't
// silently drift from what research.ts has always done.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORS_HEADERS, rateLimited, clientIp, checkToken } from './apiGuard.ts';

function req(headers = {}) {
  return new Request('https://example.com/api/research', { method: 'POST', headers });
}

test('CORS_HEADERS: allows POST/OPTIONS with the token header the add-in sends', () => {
  assert.equal(CORS_HEADERS['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.ok(CORS_HEADERS['Access-Control-Allow-Headers'].includes('X-CaribEcon-Token'));
});

test('clientIp: reads the first hop of x-forwarded-for', () => {
  assert.equal(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '1.2.3.4');
});

test('clientIp: falls back to "unknown" rather than throwing when the header is absent', () => {
  assert.equal(clientIp(req()), 'unknown');
});

test('rateLimited: false for the first RATE_LIMIT (12) hits, true on the 13th within the window', () => {
  const ip = `test-ip-${Math.random()}`;
  for (let i = 0; i < 12; i++) {
    assert.equal(rateLimited(ip), false, `hit ${i + 1} should not be limited`);
  }
  assert.equal(rateLimited(ip), true);
});

test('rateLimited: tracks each ip independently', () => {
  const a = `ip-a-${Math.random()}`;
  const b = `ip-b-${Math.random()}`;
  for (let i = 0; i < 12; i++) rateLimited(a);
  assert.equal(rateLimited(a), true);
  assert.equal(rateLimited(b), false);
});

test('checkToken: fails closed (503) when the env var is unset', () => {
  delete process.env.CARIBECON_TEST_TOKEN_UNSET;
  const result = checkToken(req(), 'CARIBECON_TEST_TOKEN_UNSET');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 503);
    assert.equal(result.error, 'not_configured');
  }
});

test('checkToken: 401s a missing or wrong header when a token is configured', () => {
  process.env.CARIBECON_TEST_TOKEN = 'expected-value';
  try {
    const missing = checkToken(req(), 'CARIBECON_TEST_TOKEN');
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 401);

    const wrong = checkToken(req({ 'X-CaribEcon-Token': 'nope' }), 'CARIBECON_TEST_TOKEN');
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.status, 401);
  } finally {
    delete process.env.CARIBECON_TEST_TOKEN;
  }
});

test('checkToken: ok when the header matches the configured token', () => {
  process.env.CARIBECON_TEST_TOKEN = 'expected-value';
  try {
    const result = checkToken(req({ 'X-CaribEcon-Token': 'expected-value' }), 'CARIBECON_TEST_TOKEN');
    assert.equal(result.ok, true);
  } finally {
    delete process.env.CARIBECON_TEST_TOKEN;
  }
});

test('checkToken: defaults to CARIBECON_RESEARCH_TOKEN when no envVar is given', () => {
  const original = process.env.CARIBECON_RESEARCH_TOKEN;
  delete process.env.CARIBECON_RESEARCH_TOKEN;
  try {
    const result = checkToken(req());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.message, 'CARIBECON_RESEARCH_TOKEN is not set on the server.');
  } finally {
    if (original === undefined) delete process.env.CARIBECON_RESEARCH_TOKEN;
    else process.env.CARIBECON_RESEARCH_TOKEN = original;
  }
});
