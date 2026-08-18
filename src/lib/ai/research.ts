/* research() — the Research Service's one public entry point (ARCHITECTURE.md §3.1, §2.5;
 * BUILD_PLAN.md Phase 1 item 2: "interpret() -> existing buildEvidencePackage() -> synthesize()
 * -> JSON... returned as the canonical ResearchResult, not a bespoke shape per phase.")
 *
 * CURRENT SCOPE, STATED EXPLICITLY: Phase 2's code-run grounding gate is now real — verify()
 * (verify.ts) calls the actual grounding.ts checks against the synthesized answer and its
 * evidence package, and derives a real `outcome`/`publishedClaims`/`reasonCategories` from
 * whatever violations it finds, rather than assuming there are none. A claim the gate flags
 * (e.g. a fabricated figure never actually retrieved) is genuinely excluded from
 * `publishedClaims`, not just recorded. Still not built: Phase 3 (the planner — research() still
 * goes straight from interpret() to buildEvidencePackage(), with no validated ResearchPlan in
 * between) and Phase 4 (the model claims audit — verify() is called with its `audit` argument
 * omitted, so it always defaults to `{ ran: false }`; that default IS the seam Phase 4 will fill
 * in, not a placeholder to remove). Until Phase 4 exists, `outcome` reflects only what code can
 * check — attribution/overreach findings from a model verifier are not yet part of it.
 *
 * interpret()'s misses (a model-named country/indicator that does not resolve, caught by the
 * same canonicaliseIntent the picker uses) are merged into the evidence package's own misses
 * before synthesis runs, so they reach the model as a known gap exactly like a retrieval miss —
 * both are "asked for, not servable," just caught at a different stage.
 */
import { interpret } from './roles/interpret.js';
import { synthesize } from './roles/synthesize.js';
import { verify } from './verify.js';
import { buildEvidencePackage } from '../askTools.js';
import type { ResearchResult } from './contracts.js';

export interface ResearchRequest {
  question: string;
}

export async function research(
  request: ResearchRequest,
  { retrievedAt }: { retrievedAt?: string } = {},
): Promise<ResearchResult> {
  const { intent, misses } = await interpret(request.question);

  const evidence = buildEvidencePackage(intent, retrievedAt);
  evidence.misses = [...misses, ...evidence.misses];

  const answer = await synthesize(intent, evidence);
  // Third argument (the model claims audit) is intentionally omitted — see header comment.
  const verdict = verify(answer, evidence);

  return { answer, evidence, verdict };
}
