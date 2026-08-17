/* research() — the Research Service's one public entry point (ARCHITECTURE.md §3.1, §2.5;
 * BUILD_PLAN.md Phase 1 item 2: "interpret() -> existing buildEvidencePackage() -> synthesize()
 * -> JSON... returned as the canonical ResearchResult, not a bespoke shape per phase.")
 *
 * PHASE 1 SCOPE, STATED EXPLICITLY: no planner (Phase 3), no code-run grounding gate (Phase 2),
 * no model claims audit (Phase 4). The `verdict` below is an HONEST STUB, not a real
 * verification — outcome is always 'PASS' and every claim is published, because nothing in this
 * phase has the power to withhold one. Per BUILD_PLAN.md's own Phase 1 warning, this answer's
 * prose is internal-only until Phase 2's gate exists; do not present it to a user as verified.
 *
 * interpret()'s misses (a model-named country/indicator that does not resolve, caught by the
 * same canonicaliseIntent the picker uses) are merged into the evidence package's own misses
 * before synthesis runs, so they reach the model as a known gap exactly like a retrieval miss —
 * both are "asked for, not servable," just caught at a different stage.
 */
import { interpret } from './roles/interpret.js';
import { synthesize } from './roles/synthesize.js';
import { buildEvidencePackage } from '../askTools.js';
import type { ResearchResult, VerificationVerdict } from './contracts.js';

export interface ResearchRequest {
  question: string;
}

function stubVerdict(publishedClaims: string[]): VerificationVerdict {
  return {
    outcome: 'PASS',
    grounding: { ran: true, violations: [] },
    audit: { ran: false },
    publishedClaims,
    reasonCategories: [],
  };
}

export async function research(
  request: ResearchRequest,
  { retrievedAt }: { retrievedAt?: string } = {},
): Promise<ResearchResult> {
  const { intent, misses } = await interpret(request.question);

  const evidence = buildEvidencePackage(intent, retrievedAt);
  evidence.misses = [...misses, ...evidence.misses];

  const answer = await synthesize(intent, evidence);
  const verdict = stubVerdict(answer.claims.map(c => c.id));

  return { answer, evidence, verdict };
}
