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
 */
import { interpret } from './roles/interpret.js';
import { plan } from './roles/plan.js';
import { synthesize } from './roles/synthesize.js';
import { verify } from './verify.js';
import { validateResearchPlan } from '../askTools.js';
import { executeResearchPlan } from './executor.js';
import { compileEvidence, buildEvidenceNote } from './evidenceCompiler.js';
import { classifyProviderFailure, StagedProviderFailure, type PipelineStage } from './providerFailure.js';
import { ProviderCallError } from './providers/openaiCompatible.js';
import type { ResearchResult } from './contracts.js';

export interface ResearchRequest {
  question: string;
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

export async function research(
  request: ResearchRequest,
  { retrievedAt }: { retrievedAt?: string } = {},
): Promise<ResearchResult> {
  const { intent, misses } = await runModelStage('interpret', () => interpret(request.question));

  const researchPlan = await runModelStage('plan', () => plan(request.question, intent));
  const { plan: validatedPlan, misses: planMisses } = validateResearchPlan(researchPlan);

  const evidence = await executeResearchPlan(validatedPlan, retrievedAt);
  // Merge, never drop — same pattern this file has always used for interpret()'s misses, now
  // extended to the plan-validation and execution stages too (see header comment).
  evidence.misses = [...misses, ...planMisses, ...evidence.misses];

  const compiled = compileEvidence(intent, validatedPlan, evidence);
  const answer = await runModelStage('synthesize', () => synthesize(compiled));
  // verify() checks `answer` against `evidence` — the ORIGINAL EvidencePackage, never `compiled`.
  // Third argument (the model claims audit) is intentionally omitted — see header comment.
  const verdict = verify(answer, evidence);
  const evidenceNote = buildEvidenceNote(compiled);

  return { answer, evidence, verdict, evidenceNote };
}
