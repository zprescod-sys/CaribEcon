# CaribEcon — Current Engineering Context

Use this as the session bootstrap for engineering work. It is deliberately short: it states the
current product, active direction, and non-negotiable boundaries without reproducing the full
history or implementation plan. Read the linked detailed document or code only when the task
requires it.

## Product

CaribEcon is a source-backed Caribbean macroeconomic research product. Its public Astro site,
Excel add-in, and server endpoints all consume a controlled Data Hub and News Hub. The product
prioritises correct figures, traceable sources and honest gaps over breadth or fluent but
unsupported prose.

The Excel add-in is the main analyst surface. It provides deterministic `CE.*` custom functions,
Browse and structured Deep Dive/Comparison workflows, and Ask CaribEcon for grounded natural-
language research. These are one product with different interaction styles; AI augments the
deterministic workflows and must never replace them.

## Active architecture

The system has three layers:

1. **Controlled evidence.** `data/almanac-data.json`, `data/news.json`, and related curated data
   are the facts. Read economic series through `src/lib/indicators.ts` or `src/lib/dataHub.ts` as
   appropriate; do not hardcode figures in pages or model prompts.
2. **Deterministic services and rendering.** Calculations, comparisons, sources, caveats,
   workbook plans, charts, and custom functions are ordinary code. They remain usable with no AI
   provider configured.
3. **Server-side research assistance.** `POST /api/ask` orchestrates interpretation, a validated
   retrieval plan, deterministic execution, synthesis, and a grounding verdict. Providers explain
   retrieved evidence; they do not supply evidence, citations, figures, URLs, or workbook layout.

The public site stays static Astro. Server/API work may use async services, but static pages still
need snapshot/build output. The Excel task pane is a client: the research service returns the
client-neutral `ResearchResult { answer, evidence, verdict }`; it does not return Excel-specific
plans or write workbooks itself.

## Non-negotiable invariants

- **Evidence first.** Every published numeric or sourced claim must come from the evidence
  retrieved for the current request. Stable evidence references are `D:`, `N:`, and `W:`. A model
  must never invent a URL, a value, a citation, a country, or a calculation.
- **Grounding is blocking.** The deterministic grounding gate decides which claims are publishable.
  A graceful failure reports available evidence and gaps; it never silently substitutes an
  ungrounded answer or calls the legacy route behind the user's back.
- **Data and news have different meaning.** Data Hub figures are structured evidence. News Hub
  entries are headline metadata unless real article text was retrieved as separately identified
  web evidence. Do not imply article reading or causal proof from a headline.
- **Keep deterministic surfaces deterministic.** Browse, Deep Dive, Comparison, custom functions,
  calculations, and Excel rendering must work without model calls. Custom functions retain their
  output and provenance contracts.
- **Secrets stay server-side.** The Excel bundle must never contain provider credentials. The
  client-visible research token is a limited cost gate, not a provider secret or user auth system.
- **Preserve contracts.** Repository and API changes must retain deterministic retrieval,
  calculations, rendering, sources, charts, evidence IDs, vintage/source-note provenance, and the
  evidence-to-Excel boundary.
- **Static-site boundary.** Do not turn the public Astro site into live database rendering merely
  to add a backend. Database work needs a snapshot/rebuild path and proven output parity.

## Active checkpoint

At this document's update, the working branch is `feature/research-service`; refresh `git status`
and branch state before relying on that fact. The current Ask path is `api/ask.ts`; `api/research.ts`
remains a deliberate rollback path, selected only through the explicit task-pane build switch.

The live direction is to keep the deterministic core fast and introduce deeper research only as a
deliberate, bounded mode. Do not route a simple hub question through external research merely for
coverage. Any depth mode must make its retrieval scope, evidence budget, deadline, and verification
level explicit.

Current in-progress AI changes may exist in the worktree. Preserve them unless the task expressly
includes them; inspect the diff before editing nearby files.

## Task routing

Read only the sections needed for the task:

| Task | Read first |
| --- | --- |
| UI, layout, task-pane visuals | `EDDESIGN.md`; then `excel-addin/src/taskpane/` |
| Excel build, manifest, custom functions | `CLAUDE.md` Excel section; `docs/ARCHITECTURE.md` §2.4 and §7 as needed |
| Ask pipeline, providers, grounding, evidence | `docs/ARCHITECTURE.md` §§2.3, 2.5–2.7, 3–4, and the relevant `src/lib/ai/` code |
| API/runtime/deployment | `docs/ARCHITECTURE.md` §5; then the relevant `api/` file and `vercel.json` |
| Data, indicators, sources, provenance | `data/SCHEMA.md`; `src/lib/indicators.ts` or `src/lib/dataHub.ts` |
| News ingestion or editorial review | `src/lib/news.ts`, `src/lib/newsRubric.md`, and relevant `docs/news-*` files |
| Verification or release | `docs/SCREENSHOT_WORKFLOW.md`, package scripts, and the changed surface's tests |
| Historical rationale | `docs/CHANGELOG.md` or the specific archived document, on demand only |

`docs/ARCHITECTURE.md` is the canonical detailed architecture reference. Do not read all of it by
default: use the section map above and inspect only the sections that govern the task. The root
`CaribEcon_AskCaribEcon_Refined_Build_Prompt.md` is historical only and cannot override this file,
`CLAUDE.md`, current code, or the detailed architecture reference.

## Working rules

Start with the smallest relevant code/data surface. Preserve unrelated worktree changes. For
changes, run focused validation plus the appropriate build/check steps; an automated result does
not replace an Excel-host smoke test for Office.js behaviour. For plans and reviews, inspect the
live code before treating a document as current.
