# CaribEcon — Build Plan

> Execution tracker for `docs/ARCHITECTURE.md` — phase order, what ships per phase, and progress.
> `ARCHITECTURE.md` stays the single design authority (target architecture, invariants, contracts,
> diagrams); this file does not restate *why*, only *what, in what order, and how far along*.
>
> **Copied from `ARCHITECTURE.md` §7 at extraction time, not moved** — that section still exists
> there too. **This file is the one that gets updated as phases progress; `ARCHITECTURE.md`'s copy
> is a frozen snapshot kept for continuity and is not maintained in lockstep.** If the two ever
> disagree on phase content or status, this file is current.

---

## The smallest architecture that is still correct

Five things. Each one is chosen because **skipping it is expensive to retrofit**, and everything not
on this list can be added later without rework.

| # | Item                                                                     | Rework avoided                                                           |
| - | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1 | Typed contracts (`ResearchIntent/Plan/EvidencePackage/Answer/Verdict`) | retrofitting types through five roles                                    |
| 2 | Provider registry behind one adapter                                     | a hardcoded provider is a rewrite                                        |
| 3 | **EvidencePackage is the only thing synthesis sees**               | a synthesizer that once saw raw output can never be *proven* grounded   |
| 4 | Claim-structured answer with declared `figures[]`                       | retrofitting a figure parser onto free prose is lossy and never finishes |
| 5 | Deterministic grounding gate                                             | it is the actual safety property, and it doubles as your model benchmark |

Everything else — planner, Tavily, model auditor, chat polish, observability, portability hardening —
is incremental.

## Phases

Implementation proceeds **one small step at a time with explicit approval** — no batching.

| Phase | Status |
| --- | --- |
| 0a — Housekeeping | **In progress** |
| 0b — NoInfra connectivity + OpenClaw spike | Not started |
| 1 — Vertical slice + chat pane | Not started |
| 2 — Grounding gate | Not started |
| 3 — Planner + Tavily | Not started |
| 4 — MiniMax claims audit | Not started |
| 5 — Country Comparison endpoint | Not started |
| Post-buildathon | Not started |

**Phase 0a — Housekeeping (half a day, no behavior change)**

1. **Fix the test glob — quoted.** [package.json:14](../package.json#L14) is one level deep, so
   `src/lib/ai/*.test.mjs` would never run. The obvious fix is a trap: **`/bin/sh` has no globstar**,
   so an *unquoted* `src/lib/**/*.test.mjs` degrades to `src/lib/*/*.test.mjs` and silently drops all
   eight existing suites the moment `src/lib/ai/` exists. Verified. Correct fix:
   ```json
   "test": "tsx --test 'src/lib/**/*.test.mjs' 'api/**/*.test.mjs'"
   ```
2. Add `vercel.json` with an explicit `maxDuration` for the research endpoint. None exists today.
3. Update `.env.example` — it lists only `ANTHROPIC_API_KEY` + `CARIBECON_RESEARCH_TOKEN` while
   `.env` carries Nebius/MiniMax/Tavily. A fresh clone silently gets a degraded build.
4. `src/lib/apiGuard.ts` — token, rate limit, CORS, **copied** from `api/research.ts` (frozen —
   copy, never move).
5. Close the fail-open hole at
   [excelOutputs.test.mjs:562](../src/lib/excelOutputs.test.mjs#L562): `known.has(id)` passes vacuously
   if both sides ever degrade to `undefined`. Add a shape assertion on every `evidenceId`.

**Phase 0b — NoInfra connectivity + OpenClaw capability spike**

**Runs before Phase 1's vertical slice, not alongside it.** The whole runtime split
(`ARCHITECTURE.md` §5.1–§5.7) rests on assumptions about NoInfra and OpenClaw that have not yet been
exercised. Prove the pipe works — and find out what OpenClaw genuinely contributes (§3.2) — before
building the real pipeline on top of it:

```
Excel/Web → Vercel research proxy → signed server-to-server request (§5.7)
          → NoInfra/OpenClaw → CaribEcon Research Service → { "status": "ok" }
```

Verify concretely:

- NoInfra can expose the HTTPS/service endpoint the design needs.
- OpenClaw can run and supervise a real service — and note, honestly, which of its capabilities
  (lifecycle/supervision, exposing the endpoint, environment/tool configuration, log and runtime
  management, agent execution facilities) actually earned their place versus which added nothing
  over plain code. Anything in the second group stays in CaribEcon code, not OpenClaw's job list.
- Vercel can reach it over the **signed channel from §5.7** — shared secret, timestamp, nonce,
  replay rejection — with no unauthenticated path and no browser-facing CORS on the service.
- Provider keys and the Tavily key stay resolvable only from the research runtime.
- Request timeout behavior end to end is understood, not assumed.
- The service returns a real structured result, even a minimal one.

**If this basic path does not work as assumed, that has to be discovered here** — not after the full
Research Service is built on top of an untested foundation.

**Phase 1 — Contracts + vertical slice + chat pane (first demoable answer)**

- `src/lib/ai/contracts.ts` (types only), provider registry + `openaiCompatible.ts`, `config.ts`.
- `interpret()` → existing `buildEvidencePackage()` → `synthesize()` → JSON. **No planner, no gate,
  no auditor yet.**
- Synthesizer emits the **claim-structured `ResearchAnswer` from day one**, returned as the canonical
  `ResearchResult` (`ARCHITECTURE.md` §2.5) — not a bespoke shape per phase.
- **Chat UI in the Excel task pane ships here, not last.** It is the highest-variance,
  least-testable surface in the project (Office.js + WebView2 + the `build:addin` → `public/addin/`
  publish loop). Deferring it hides that risk until the end.
- **This phase's prose is explicitly internal-only — it is what Phase 2's gate has nothing yet to
  check.** With no gate built, an unsupported figure or claim can reach whoever sees the pane, and
  the whole architecture's central promise (§2.1: "no model may produce anything the core doesn't")
  does not hold yet at this stage. Keep the build in your own hands, or behind a state visibly
  marked unverified, until Phase 2 ships — never present Phase 1 output as demo-ready. Evidence,
  tables, and charts (all deterministic, all already grounded) are safe to show earlier; the
  narrative specifically is not.
- **Capture real model outputs to a fixture file.** Phase 2's gate is calibrated against these.

**The real runtime build-out follows Phase 0b's proven connectivity:**

- Thin research proxy on Vercel, target read from `CARIBECON_RESEARCH_TARGET`, calling over the
  signed channel proven in Phase 0b.
- Deploy the actual Research Service to NoInfra (primary) and, per §5.4, prove the Vercel fallback
  once rather than operate it continuously.
- Stand up the data-refresh mechanism from §5.5 — direct fetch of the two hub JSON files, atomic
  write, restart — **decoupled from any code deployment path.** Verify `news.json` actually refreshes
  on schedule.
- Note the NoInfra renewal date; set a **day-18** reminder to make the §5.4 operational call.

**Phase 2 — The grounding gate**

Built against Phase 1's captured outputs, not against speculation. Ship **advisory** (annotate the
response), flip to **blocking** once the false-positive rate is known. Full check list, the
number-matching rule, and the explicit limits are in `ARCHITECTURE.md` **§2.6**.

**Phase 3 — Planner + code executor + Tavily**

- `validateResearchPlan` mirroring `canonicaliseIntent`'s discipline: every country through
  `resolveCountry`, every indicator through `resolveIndicator`, every `onStep` against an earlier
  step id. Invalid steps **dropped with a `RetrievalMiss`**, never guessed.
- Executor = plain loop. One optional re-plan.
- `src/lib/webEvidence.ts`; `search_web` / `extract_web` as validated step kinds. The executor
  **refuses any Tavily call whose `authorizedBy` does not name a validated step.**
- Gate gains the **quote check**: a quoted span on a `W:` ref must be a substring of `extract.text`.

**Phase 4 — MiniMax claims audit**

Findings → verdict mapped **by code**. Degrades to gate-alone. Sequenced here deliberately: the gate
already catches the failure mode that matters (fabrication). Ship the gate, log what it rejects, then
decide whether the audit earns its latency and second provider dependency.

**Phase 5 — Country Comparison endpoint (deterministic)**

`api/comparison.ts` reusing `validateComparisonPicker` + `getSelectedCountrySeries` +
`buildWorkbookPlan`. **Zero model calls.** Cheap — **pull this forward if the buildathon demo needs
the TT-vs-GY showcase.** It blocks nothing and depends on nothing.

**Post-buildathon** — OllyGarden instrumentation, web research surface on caribecon.org, portability
hardening, `api/research.ts` deletion.

## Budget and caps — initial buildathon defaults, not permanent invariants

One **shared mutable deadline object** threaded through every role — *not* per-call timeouts. Five
independent 12s timeouts compose into a 60s kill that returns nothing after paying for every token.

**Every number below is a starting point, reasoned from first principles rather than measured.** They
exist so the first build has *some* bound rather than none — treat them as defaults to calibrate once
real latency, reliability, token usage and cost are observed, not as fixed architecture:

```
WALL_CLOCK_MS 45_000 · PROVIDER_TIMEOUT_MS 12_000 (retry on 429/5xx only, never 4xx)
MAX_MODEL_CALLS 5 · MAX_PLAN_STEPS 8 (truncate, don't reject) · MAX_TOOL_CALLS 12
MAX_TAVILY_SEARCHES 2 · MAX_TAVILY_EXTRACTS 3 · MAX_EXTRACT_CHARS 6_000 · MAX_EXTRACT_TOTAL 15_000
MAX_EVIDENCE_BYTES 24_000   ← bytes, not item count: one 25-year series outweighs six headlines
RETRY_BUDGET 1 · MAX_HISTORY_TURNS 4 · MAX_REHYDRATED_REFS 40
```

**Degradation order under deadline pressure — keep this fixed even as the numbers above move:**
**drop audit → drop re-plan → drop synthesis** and return evidence + tables only. This ordering is a
design decision about what matters least under pressure, not a measured quantity — change it only if
real usage gives a concrete reason to, not as a side effect of retuning the numbers.
