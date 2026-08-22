/* A user cancellation is neither a provider failure nor a retrieval miss. It must escape the
 * pipeline so no later stage begins once the user selected Stop. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException('Research request was cancelled.', 'AbortError');
}

export function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
