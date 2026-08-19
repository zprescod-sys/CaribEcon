import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderCallError } from './providers/openaiCompatible.ts';
import { classifyProviderFailure } from './providerFailure.ts';

function failure(status, kind = 'http') {
  return classifyProviderFailure(
    new ProviderCallError(
      'provider detail must not reach the client',
      status,
      'test-provider',
      'test-model',
      '/chat/completions',
      kind,
    ),
    'interpret',
  );
}

test('classifies provider HTTP failures into stable user-safe codes', () => {
  assert.deepEqual(
    [401, 403, 404, 400, 422, 429, 500, 503].map(
      (status) => failure(status).code,
    ),
    [
      'provider_auth',
      'provider_auth',
      'provider_not_found',
      'provider_bad_request',
      'provider_bad_request',
      'provider_rate_limited',
      'provider_server_error',
      'provider_server_error',
    ],
  );
});

test('keeps retryability deterministic across transport and configuration failures', () => {
  assert.equal(failure(null, 'timeout').retryable, true);
  assert.equal(failure(null, 'unreachable').retryable, true);
  assert.equal(failure(404).retryable, false);
  assert.equal(failure(401).retryable, false);
  assert.equal(failure(429).retryable, true);
});
