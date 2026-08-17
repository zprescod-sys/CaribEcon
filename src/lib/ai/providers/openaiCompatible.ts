/* The one function that knows the OpenAI chat-completions wire format. Nebius, MiniMax, and
 * NoInfra's inference endpoint (docs/NOINFRA_SPIKE.md — confirmed "api": "openai-completions")
 * all speak this same protocol, which is why this project has ONE adapter and a registry
 * (../config.ts) rather than one file per provider — ARCHITECTURE.md §6: "providers/nebius.ts +
 * providers/minimax.ts -> one openaiCompatible.ts + a registry." If Impala's API ever turns out
 * not to be OpenAI-compatible (§4.3), it gets its own small adapter beside this one; every role
 * function and everything in config.ts stays unchanged.
 *
 * Deliberately ONE call, no retry loop: §7's RETRY_BUDGET is a per-REQUEST budget shared across
 * a whole research pipeline, not a per-call setting, so retry orchestration belongs to whatever
 * composes multiple calls (the future interpret/plan/synthesize/verify functions), not to this
 * single-call primitive.
 */
import type { ResolvedProvider } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallModelOptions {
  temperature?: number;
  maxTokens?: number;
  /* Defaults to ARCHITECTURE.md §7's PROVIDER_TIMEOUT_MS starting point. That number is
     explicitly a "reasoned guess... treat as a default to calibrate once real latency... is
     observed" — overridable per call for exactly that calibration. */
  timeoutMs?: number;
}

export interface ModelResponse {
  text: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
}

export class ProviderCallError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;

export async function callModel(
  connection: ResolvedProvider,
  model: string,
  messages: ChatMessage[],
  options: CallModelOptions = {},
): Promise<ModelResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${connection.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new ProviderCallError(
      timedOut
        ? `${connection.name} did not respond within ${timeoutMs}ms.`
        : `${connection.name} is unreachable.`,
      null,
    );
  }

  const raw = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ProviderCallError(`${connection.name} returned a non-JSON response.`, response.status);
  }

  if (!response.ok) {
    throw new ProviderCallError(
      extractErrorMessage(body) ?? `${connection.name} returned ${response.status}.`,
      response.status,
    );
  }

  const choice = (
    body as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
  ).choices?.[0];
  if (!choice?.message?.content) {
    throw new ProviderCallError(`${connection.name} returned no message content.`, response.status);
  }

  const usage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;

  return {
    text: choice.message.content,
    finishReason: choice.finish_reason ?? null,
    usage: usage
      ? { promptTokens: usage.prompt_tokens ?? null, completionTokens: usage.completion_tokens ?? null }
      : null,
  };
}

function extractErrorMessage(body: unknown): string | null {
  const error = (body as { error?: { message?: string } | string } | null)?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return null;
}
