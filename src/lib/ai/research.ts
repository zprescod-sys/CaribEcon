/* research() — the Research Service's one public entry point (ARCHITECTURE.md §3.1, §2.5;
 * BUILD_PLAN.md Phase 1 item 2: "interpret() -> existing buildEvidencePackage() -> synthesize()
 * -> JSON... returned as the canonical ResearchResult, not a bespoke shape per phase.")
 *
 * CURRENT SCOPE, STATED EXPLICITLY: Phase 3 is now wired in — research() goes
 * interpret() -> plan() -> validateResearchPlan() -> executeResearchPlan() -> synthesize() ->
 * verify(), replacing the old direct interpret() -> buildEvidencePackage() hop.
 * validateResearchPlan() (askTools.ts) is the one place a plan's named countries/indicators/
 * onStep references are checked against the real hub — plan() itself only checks JSON shape
 * (its own file header). executeResearchPlan() (executor.ts) then runs the validated plan's
 * steps against the existing deterministic tools and, where the plan calls for it, Tavily
 * search/extract and the news-digest side path — producing the same EvidencePackage shape
 * buildEvidencePackage() always has. Phase 2's code-run grounding gate is still real — verify()
 * (verify.ts) calls the actual grounding.ts checks (now 11 of them, §2.6) against the
 * synthesized answer and its evidence package, and derives a real
 * `outcome`/`publishedClaims`/`reasonCategories` from whatever violations it finds, rather than
 * assuming there are none. A claim the gate flags (e.g. a fabricated figure never actually
 * retrieved) is genuinely excluded from `publishedClaims`, not just recorded. Still not built:
 * Phase 4 (the model claims audit — verify() is called with its `audit` argument omitted, so it
 * always defaults to `{ ran: false }`; that default IS the seam Phase 4 will fill in, not a
 * placeholder to remove). Until Phase 4 exists, `outcome` reflects only what code can check —
 * attribution/overreach findings from a model verifier are not yet part of it.
 *
 * Three sources of "asked for, not servable" are merged into the evidence package's own misses
 * before compilation/synthesis runs, so all of them reach the model as a known gap exactly like a
 * retrieval miss — interpret()'s misses (a model-named country/indicator that does not resolve),
 * validateResearchPlan()'s misses (a plan step naming an unresolved country/indicator/onStep),
 * and executeResearchPlan()'s own misses (a step that ran but came back empty, a budget skip, an
 * unauthorized extract_web call) — never dropped, only ever appended to.
 *
 * Synthesis Latency + Evidence Compiler upgrade (Stage C): evidenceCompiler.ts's compileEvidence()
 * now sits between executeResearchPlan() and synthesize() — synthesize() reads the compact
 * CompiledEvidence it produces, never the raw EvidencePackage directly. verify() is UNCHANGED and
 * still checks the synthesized answer against the original, untouched `evidence` — the
 * safety-critical property this whole upgrade depends on (see the plan). `evidenceNote` is built
 * from the same CompiledEvidence, deterministically, and returned alongside the answer for the
 * task pane to show (a short inline line plus a collapsible detailed list) without the model ever
 * generating that count or that prose itself.
 *
 * CARIBECON_ROUTE_MODE (plans/interpret-plan-merge-latency-review.md): default (unset, or anything
 * other than 'staged') runs the merged routePlan() role — one model call producing both the
 * interpretation and the plan — in place of the original interpret()+plan() two-call sequence.
 * §7 Step 4's parity bar was met on live-audit sweeps (N=3 per question, multiple question
 * categories) against CARIBECON_ROUTEPLAN_PROVIDER/_MODEL=nebius/Qwen3-30B-A3B-Instruct-2507: zero
 * misses, stable plan composition, and a prompt fix (routePlan.ts's buildSystemPrompt) that closed
 * the one real gap found — broad economy-condition questions ("How is X doing?") collapsing to a
 * news-only plan with no structured retrieval. That gap does not exist in the staged path (plan()
 * re-reads the question independently of what interpret() returned), which is why 'staged' is kept
 * as an explicit fallback rather than removed: set CARIBECON_ROUTE_MODE=staged to roll back to the
 * original two-call path with no redeploy. Every deterministic function from
 * validateResearchPlan() onward is byte-for-byte identical either way, because both paths converge
 * on the same ResearchIntent/ResearchPlan shapes before that call.
 */
import { interpret } from './roles/interpret.js';
import { plan } from './roles/plan.js';
import { routePlan } from './roles/routePlan.js';
import { synthesize } from './roles/synthesize.js';
import { verify } from './verify.js';
import { validateResearchPlan } from '../askTools.js';
import { executeResearchPlan, recoverEvidenceOnce, type RecoveryContext } from './executor.js';
import { compileEvidence, buildEvidenceNote } from './evidenceCompiler.js';
import { classifyProviderFailure, StagedProviderFailure, type PipelineStage } from './providerFailure.js';
import { ProviderCallError } from './providers/openaiCompatible.js';
import { throwIfAborted } from './cancellation.js';
import type {
  ConversationTurn,
  ResearchResult,
  ResearchIntent,
  ResearchPlan,
  EvidencePackage,
  ResearchAnswer,
  VerificationVerdict,
  RetrievalMiss,
} from './contracts.js';

export interface ResearchRequest {
  question: string;
  /* Oldest-first, already clamped to MAX_HISTORY_TURNS/MAX_REHYDRATED_REFS by the caller
   * (api/ask.ts) — research() trusts its shape the same way it trusts `question` having already
   * been trimmed and length-capped. Optional and additive: omitting it is identical to every
   * request before this feature existed. */
  history?: ConversationTurn[];
}

async function runModelStage<T>(stage: PipelineStage, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProviderCallError) {
      throw new StagedProviderFailure(classifyProviderFailure(error, stage));
    }
    throw error;
  }
}

function evidenceRecoveryContext(evidence: EvidencePackage): RecoveryContext {
  return {
    trigger: 'evidence',
    missingIndicatorsOrData: evidence.misses.filter(miss => miss.kind === 'indicator' || miss.kind === 'years').map(miss => miss.detail),
    failedRetrievals: evidence.misses.filter(miss => miss.kind !== 'indicator' && miss.kind !== 'years').map(miss => miss.detail),
    sourcesOrAnglesTried: [...evidence.toolsUsed, ...(evidence.web ?? []).map(item => item.domain)].filter(Boolean),
  };
}

function needsEvidenceRecovery(evidence: EvidencePackage): boolean {
  return evidence.misses.length > 0 || (evidence.data.length === 0 && !(evidence.web ?? []).some(item => item.extract));
}

function needsSynthesisRecovery(answer: ResearchAnswer, verdict: VerificationVerdict): boolean {
  // An intentionally empty, fully verified answer is not evidence insufficiency. Recovery is for
  // a substantive draft whose claims were all removed by the grounding gate.
  return answer.claims.length > 0 && verdict.publishedClaims.length === 0;
}

function synthesisRecoveryContext(answer: ResearchAnswer, verdict: VerificationVerdict, evidence: EvidencePackage): RecoveryContext {
  return {
    ...evidenceRecoveryContext(evidence),
    trigger: 'synthesis',
    unsupportedClaimsOrGaps: [
      ...answer.gaps,
      ...verdict.reasonCategories.map(reason => `Verification gap: ${reason}`),
      'Synthesis produced no publishable grounded claims.',
    ],
  };
}

export async function research(
  request: ResearchRequest,
  { retrievedAt, signal }: { retrievedAt?: string; signal?: AbortSignal } = {},
): Promise<ResearchResult> {
  throwIfAborted(signal);
  // Read per-call, not cached at module scope — same discipline every other env-driven decision
  // in this pipeline already follows (config.ts's resolveRole/resolveProvider both read
  // process.env fresh on every call), so a test can flip CARIBECON_ROUTE_MODE per case and so a
  // running server picks up a config change without a restart.
  // 'staged' is the one explicit opt-out; unset or any other value runs the combined role (see the
  // header comment for why this is now the default, not 'combined' as an opt-in).
  const combined = process.env.CARIBECON_ROUTE_MODE !== 'staged';

  // Per-stage timing (plans/interpret-plan-merge-latency-review.md §7 Step 0 — "wire a
  // performance.now() wrap around each of the four sequential calls, log it server-side").
  // Additive/diagnostic only: logged, never returned in ResearchResult, so this changes no
  // contract api/ask.ts or the task pane depends on.
  const requestStartedAt = performance.now();
  const timings: Record<string, number> = {};

  let intent: ResearchIntent;
  let misses: RetrievalMiss[];
  let researchPlan: ResearchPlan;
  if (combined) {
    const stageStartedAt = performance.now();
    const routed = await runModelStage('route_plan', () => routePlan(request.question, request.history, { signal }));
    timings.routePlanMs = Math.round(performance.now() - stageStartedAt);
    intent = routed.intent;
    misses = routed.misses;
    researchPlan = routed.plan;
  } else {
    const interpretStartedAt = performance.now();
    const interpreted = await runModelStage('interpret', () => interpret(request.question, request.history, { signal }));
    timings.interpretMs = Math.round(performance.now() - interpretStartedAt);
    intent = interpreted.intent;
    misses = interpreted.misses;
    const planStartedAt = performance.now();
    researchPlan = await runModelStage('plan', () => plan(request.question, intent, { signal }));
    timings.planMs = Math.round(performance.now() - planStartedAt);
  }

  const { plan: validatedPlan, misses: planMisses } = validateResearchPlan(researchPlan);

  const executeStartedAt = performance.now();
  let evidence = await executeResearchPlan(validatedPlan, retrievedAt, { signal, recovery: { enabled: false } });
  timings.executeMs = Math.round(performance.now() - executeStartedAt);
  // Merge, never drop — same pattern this file has always used for interpret()'s misses, now
  // extended to the plan-validation and execution stages too (see header comment).
  evidence.misses = [...misses, ...planMisses, ...evidence.misses];

  let recoveryUsed = false;
  if (needsEvidenceRecovery(evidence)) {
    const recoveryStartedAt = performance.now();
    const recovery = await recoverEvidenceOnce(validatedPlan, evidence, evidenceRecoveryContext(evidence), retrievedAt, { signal });
    timings.recoveryMs = Math.round(performance.now() - recoveryStartedAt);
    evidence = recovery.evidence;
    recoveryUsed = true;
    console.log('research: recovery', { trigger: 'evidence', completed: recovery.completed, timedOut: recovery.timedOut, recoveryMs: timings.recoveryMs });
  }

  let compiled = compileEvidence(intent, validatedPlan, evidence);
  const synthesizeStartedAt = performance.now();
  let answer = await runModelStage('synthesize', () => synthesize(compiled, { signal }));
  timings.synthesizeMs = Math.round(performance.now() - synthesizeStartedAt);
  // verify() checks `answer` against `evidence` — the ORIGINAL EvidencePackage, never `compiled`.
  // Third argument (the model claims audit) is intentionally omitted — see header comment.
  const verifyStartedAt = performance.now();
  let verdict = verify(answer, evidence);
  timings.verifyMs = Math.round(performance.now() - verifyStartedAt);
  if (!recoveryUsed && needsSynthesisRecovery(answer, verdict)) {
    const recoveryStartedAt = performance.now();
    const recovery = await recoverEvidenceOnce(validatedPlan, evidence, synthesisRecoveryContext(answer, verdict, evidence), retrievedAt, { signal });
    timings.recoveryMs = Math.round(performance.now() - recoveryStartedAt);
    evidence = recovery.evidence;
    recoveryUsed = true;
    console.log('research: recovery', { trigger: 'synthesis', completed: recovery.completed, timedOut: recovery.timedOut, recoveryMs: timings.recoveryMs });
    if (recovery.completed) {
      compiled = compileEvidence(intent, validatedPlan, evidence);
      answer = await runModelStage('synthesize', () => synthesize(compiled, { signal }));
      verdict = verify(answer, evidence);
    }
  }
  const evidenceNote = buildEvidenceNote(compiled);

  timings.totalMs = Math.round(performance.now() - requestStartedAt);
  console.log('research: stage timings', { mode: combined ? 'combined' : 'staged', ...timings });

  return { answer, evidence, verdict, evidenceNote };
}
