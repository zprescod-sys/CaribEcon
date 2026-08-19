/* Normalizes provider failures into stable, safe application-level codes. Classification has no
   retry, fallback, or route-health side effects: those need a shared request deadline and explicit
   configured routes, neither of which belongs in this first failure-handling pass. */
import { ProviderCallError } from './providers/openaiCompatible.js';

export type PipelineStage = 'interpret' | 'plan' | 'execute' | 'news_extract' | 'synthesize' | 'verify';

export type ProviderFailureCode =
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_auth'
  | 'provider_not_found'
  | 'provider_bad_request'
  | 'provider_rate_limited'
  | 'provider_server_error'
  | 'provider_invalid_response';

export interface ProviderFailure {
  code: ProviderFailureCode;
  provider: string;
  model: string;
  endpoint: string;
  stage: PipelineStage;
  providerStatus: number | null;
  retryable: boolean;
  message: string;
}

export class StagedProviderFailure extends Error {
  constructor(public readonly failure: ProviderFailure) {
    super(failure.code);
  }
}

export function classifyProviderFailure(
  error: ProviderCallError,
  stage: PipelineStage,
): ProviderFailure {
  const base = {
    provider: error.provider,
    model: error.model,
    endpoint: error.endpoint,
    stage,
    providerStatus: error.status,
  };

  if (error.kind === 'timeout') {
    return {
      ...base,
      code: 'provider_timeout',
      retryable: true,
      message: 'The AI service took too long to respond. Please try again.',
    };
  }
  if (error.kind === 'unreachable') {
    return {
      ...base,
      code: 'provider_unreachable',
      retryable: true,
      message:
        'An AI service is temporarily unavailable. Please try again shortly.',
    };
  }
  if (error.kind === 'invalid_response') {
    return {
      ...base,
      code: 'provider_invalid_response',
      retryable: true,
      message: 'The AI service returned an invalid response. Please try again.',
    };
  }
  if (error.status === 401 || error.status === 403) {
    return {
      ...base,
      code: 'provider_auth',
      retryable: false,
      message:
        'An AI service required for this request is not configured correctly.',
    };
  }
  if (error.status === 404) {
    return {
      ...base,
      code: 'provider_not_found',
      retryable: false,
      message:
        'The configured AI model or service endpoint is currently unavailable.',
    };
  }
  if (error.status === 400 || error.status === 422) {
    return {
      ...base,
      code: 'provider_bad_request',
      retryable: false,
      message:
        'Ask CaribEcon could not complete this request because an AI service rejected its configuration.',
    };
  }
  if (error.status === 429) {
    return {
      ...base,
      code: 'provider_rate_limited',
      retryable: true,
      message:
        'An AI service is temporarily at capacity. Please try again shortly.',
    };
  }
  return {
    ...base,
    code: 'provider_server_error',
    retryable: true,
    message:
      'An AI service is experiencing a temporary problem. Please try again shortly.',
  };
}
