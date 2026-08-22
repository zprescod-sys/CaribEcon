/* The shared mutable deadline object ARCHITECTURE.md §7 specifies and §5.6 extends, built now:
 * "One shared mutable deadline object threaded through every role — not per-call timeouts. Five
 * independent 12s timeouts compose into a 60s kill that returns nothing after paying for every
 * token." §5.6 adds the one method this file is built around: "the spend cap is one more
 * condition that object's remaining() check honors" — so this is named a BUDGET, not a deadline,
 * on purpose: a deadline is one thing to check, a budget is the thing future conditions (a daily
 * spend cap, per §5.6) get added to without a second mechanism appearing beside it.
 *
 * ONE AbortController, not `AbortSignal.timeout()` per call — a timeout signal has no identity
 * another piece of code can test for ("did THIS specific deadline fire, or did some other timeout
 * that happens to look the same?"). This controller's `signal.reason` is always the same
 * `DeadlineExpiredError` instance, which is what lets openaiCompatible.ts's classification seam
 * (§4b of the design) distinguish "the shared budget expired" from every other way a fetch can
 * fail, and react differently: never wrapped into ProviderCallError, never surfaced as a 5xx.
 *
 * Composition rule callers must follow (not enforced by the type system, stated here once): call
 * `remainingAfterReserve(reserveMs)` BEFORE starting a role's call, not `remaining()` alone, and
 * skip the call (recording a degradation) rather than starting it if the answer is <= 0. Aborting
 * a call mid-flight still pays for every token the provider generated before the abort landed;
 * not starting it pays nothing. The reserve is what makes ARCHITECTURE.md §7's fixed degradation
 * order (drop audit -> drop re-plan -> drop synthesis) a real guarantee rather than an accident of
 * timing — without it, a slow re-plan or a slow digest batch can eat the tail that synthesis was
 * supposed to get, silently inverting the order §7 says must stay fixed even as the numbers move.
 */

export class DeadlineExpiredError extends Error {
  constructor(wallClockMs: number) {
    super(`Research budget expired after ${wallClockMs}ms.`);
  }
}

export type DegradationStep = 'audit' | 'replan' | 'news_digest' | 'tavily' | 'synthesis';

export interface Degradation {
  step: DegradationStep;
  reason: string;
  /* Milliseconds elapsed since the budget was created, not remaining time — a degradation is a
     fact about WHEN in the request something was cut, which is what a log line or a future
     calibration pass actually wants to know. */
  atMs: number;
}

export interface ResearchBudget {
  readonly startedAt: number;
  readonly wallClockMs: number;
  /** Milliseconds left before the deadline, floored at 0. Never negative. */
  remaining(): number;
  /** `remaining() - reserveMs`, floored at 0 — what a role may safely assume it has BEFORE
      starting, once `reserveMs` has been set aside for whatever must run after it. */
  remainingAfterReserve(reserveMs: number): number;
  expired(): boolean;
  /** Fires once, at creation time + wallClockMs, with `reason` set to a DeadlineExpiredError —
      the one shared signal identity every role call composes with. Never fires more than once;
      an already-expired budget's signal is already aborted, so composing with it later is safe
      and immediate, not a second timer. */
  readonly signal: AbortSignal;
  /** The signal an individual call should actually use: this budget's shared signal composed
      with a per-call ceiling, whichever is stricter. Existing per-role `timeoutMs` values keep
      their meaning as "the sane ceiling for this role in isolation" — the budget only ever
      tightens them, never loosens them past what a role already declares safe. */
  signalFor(callCeilingMs: number): AbortSignal;
  /** Records that `step` was skipped or cut short, and why. Purely bookkeeping — does not itself
      change what `remaining()`/`expired()` report; callers still decide, and are still
      responsible for actually not doing the work once they've called this. */
  degrade(step: DegradationStep, reason: string): void;
  readonly degradations: readonly Degradation[];
  /** Clears the underlying timer. MUST be called once the request is done (research()'s own
      `finally`) — an undisposed budget holds a live Node timer for the rest of `wallClockMs`,
      which is otherwise harmless but needlessly keeps the process alive under a test runner or a
      short-lived function invocation. Safe to call more than once. */
  dispose(): void;
}

export function createResearchBudget(wallClockMs: number): ResearchBudget {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DeadlineExpiredError(wallClockMs)), wallClockMs);
  const degradations: Degradation[] = [];

  function remaining(): number {
    return Math.max(0, wallClockMs - (Date.now() - startedAt));
  }

  return {
    startedAt,
    wallClockMs,
    remaining,
    remainingAfterReserve(reserveMs: number): number {
      return Math.max(0, remaining() - reserveMs);
    },
    expired(): boolean {
      return controller.signal.aborted;
    },
    signal: controller.signal,
    signalFor(callCeilingMs: number): AbortSignal {
      // min(callCeilingMs, remaining()) — never larger than what's actually left, and never
      // larger than the role's own declared ceiling either.
      return AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(0, Math.min(callCeilingMs, remaining())))]);
    },
    degrade(step: DegradationStep, reason: string): void {
      degradations.push({ step, reason, atMs: Date.now() - startedAt });
    },
    degradations,
    dispose(): void {
      clearTimeout(timer);
    },
  };
}
