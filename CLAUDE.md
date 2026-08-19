# CLAUDE.md — CaribEcon

Read `CURRENT_CONTEXT.md` at the start of every engineering session. It is the compact orientation
and task-routing document. This file provides durable repository guidance; do not load the full
architecture plan unless the current task needs a named section.

- **Design / visual system → `EDDESIGN.md`** — the sole authority on look: color, type, geometry, motion, components, page layout.
- **Data schema & sourcing → `data/SCHEMA.md`** — the canonical record shape, indicator slugs, source tiers, and integrity rules.
- **Current engineering context → `CURRENT_CONTEXT.md`** — session bootstrap, active direction, invariants, and task routing.
- **Engineering plan & architecture → `docs/ARCHITECTURE.md`** — canonical detailed reference; read the relevant section on demand.
- QA workflow → `docs/SCREENSHOT_WORKFLOW.md`.
- **Project history → `docs/CHANGELOG.md`** — read on demand, not every session: the *why* behind past migrations, rebuilds, and fixes.

## Active build — CaribEcon Excel buildathon

**The canonical engineering plan is `docs/ARCHITECTURE.md`.** It governs the whole product: the
existing Browse and custom-function surface, Single Country Deep Dive, Country Comparison,
structured charts/output, and the Ask CaribEcon Research Agent — provider roles, the deterministic
grounding gate, evidence contracts, and the NoInfra/Vercel runtime split. `CURRENT_CONTEXT.md`
states the mandatory boundaries; read the relevant architecture section before a change that
affects its design, not as a whole-file session bootstrap.

Do not read `docs/ARCHITECTURE.md` in full by default. Read only the section relevant to the current task. Do not load historical build prompts unless the task explicitly requires historical context.

`CaribEcon_AskCaribEcon_Refined_Build_Prompt.md` (repo root, tracked) is retired as the active
plan — the same treatment it once gave its own predecessor, the multi-agent
`CaribEcon_Build_Worflow.pdf`. It remains a historical record only; `docs/ARCHITECTURE.md` §6
(Migration) records exactly what was kept, changed, and removed from it. `plans/` alongside it is
gitignored and holds local-only strategy/roadmap material, not an active plan.

Nebius, MiniMax, and (when access lands) Impala are shared, server-side AI infrastructure —
`docs/ARCHITECTURE.md` §4 is authoritative on which provider serves which role. None of them own
facts, citations, calculations, workbook coordinates, tables, or charts. The controlled Data Hub
and News Hub remain the source of truth; deterministic code retrieves, calculates, validates, and
renders.

Standing constraints that outlive any single session:

- **`api/research.ts` is frozen** for the duration of the buildathon. The new `/api/ask` path
  lives beside it. `ASK_CARIBECON_MODE=ask|legacy` is an explicit task-pane rollback switch.
  There is no `ASK_RETRIEVER_MODE=agentic` toggle — retired per `docs/ARCHITECTURE.md` §6; the
  research pipeline plans once and executes in code, never a model tool-loop. Do not silently
  fall back to `/api/research` within a request.
- **The existing add-in workflow is the foundation, and it stays.** Browse, the structured
  input → table output flow, and all seven `CE.*` functions are kept as-is and require no model
  call. AI is an optional capability for natural-language workflows; it does not replace or
  destabilise the deterministic surface.
- **Citations stay deterministic** — populated only from real retrieval results, never from model
  prose. No model ever composes a URL or a figure.
- **News is metadata evidence only** (headline / source / date / link). Never imply an article
  body was read; hedge contextual claims; never infer causality from co-occurrence.
- Task-pane visual work follows `EDDESIGN.md`, same as the site.
- Provider keys stay server-side; the Excel bundle never carries one. Provider/model selection is
  environment-configured and new provider paths must fail closed when a configured model is absent.
- `CARIBECON_RESEARCH_TOKEN` is an existing client-visible cost gate, not a provider secret or
  production-grade user authentication. Never put `NEBIUS_API_KEY` or `MINIMAX_API_KEY` in the
  webpack environment substitutions.

**Current plan status:** the local `feature/excel-addin` branch already contains the Phase 0
deterministic News Hub reader and Ask retrieval facade (`src/lib/news.ts`, `src/lib/askTools.ts`).
Treat that as completed groundwork, but add its contract tests and planned hardening before any
provider call or new endpoint work.

**CariBench is shelved** as of 2026-08-09 and is explicitly out of scope in the active plan. The
spec, the draft question set, the gold records, and both spike runs are committed on
`feature/caribench`; `CARIBENCH.md` §0 records why it stopped and what must be settled before it
resumes. Do not restart benchmark runs as part of this build.

## What This Is

A multi-page Caribbean macroeconomic research tool with the register of a research institute, not a landing page. Separate pages share one shell and one data hub: 19 economies, 24 macro indicators, budgets, news, publications, deals, and a deferred client-facing chart builder (Analysis).

Bar: a portfolio-grade piece for GitHub and LinkedIn — evidence of connecting a real economic problem to a structured workflow. Credibility and rigor over visual flash; professional and near-perfect.

## Tech Stack (locked)

- **Framework:** Astro — static output, native multi-page.
- **Charts:** D3.js, hand-built and hub-driven (never hardcoded data).
- **Export:** SheetJS (`xlsx`) 0.18.5, dynamic-imported on demand.
- **Hosting:** Vercel
- **No dark mode** unless explicitly requested — no color-scheme logic.
- All fonts and visual rules live in `EDDESIGN.md`.

## Data Hub (single source of truth)

Every page reads from one hub; no per-page hardcoded numbers.

- **Canonical dataset:** `data/almanac-data.json` — 24 indicators × 19 countries, full provenance per record. Read through `src/lib/dataHub.ts` (typed by `src/lib/types.ts`); never import the JSON directly in a page.
- **Presentation policy:** `data/indicator-meta.json` — slug-keyed `chartGroup` / `defaultChart` / `order`. `label` and `unit` derive from the records. `dataHub.ts` warns at build if a data slug has no meta entry.
- **Other domain files:** `data/budgets.json`, `news.json`, `news_unclassified.json`, `publications.json`, `deals.json`.
- **Schema, slugs, source tiers, and the debt-ratio merge rule:** `data/SCHEMA.md` (authoritative).
- **Integrity (summary; full rules in SCHEMA):** every number carries `source` / `vintage` / `type` (`actual | estimate | projection | derived`); prefer primary over comparable sources; show `null` + "Unavailable" rather than guess; flag source divergences in `seriesNote` / `sourceNote`; for news and publications store headline + source + date + link only — never republish bodies.
- Phase 2 (later): a scheduled fetcher replaces the hand-collected static hub.

## Pages

- **Home** — daily briefing (repoints per story) + per-country key-indicators rail + regional indexed-GDP chart + Explore links + recent news.
- **Data** — chart explorer (country multi-select, indicator selector, year-in-focus) + CSV/XLSX export + budget pie; FDI and spending-vs-revenue views planned.
- **News** — all Caribbean news, country filter chips.
- **Publications** — browsable index (title, summary, type, date, link out); host nothing.
- **Deals & Investment** — headline M&A / FDI list, headlines only.

## Architecture

- The front end is a pure presentation layer — it reads the hub and never calls external APIs directly.
- Any live API keys stay server-side (Vercel Function).
- Regenerable / scratch output lives in `/data/` or `/.tmp/`.

### Public API (`/api/*`)

Standalone Vercel Functions in the top-level `api/`, deliberately outside the Astro build so the site stays `output: 'static'`. They must import `src/lib/indicators.ts` — **never `dataHub.ts`**, which pulls the editorial domains (~1.9 MB) in at module scope, and which is not nodenext-clean so it throws `ERR_MODULE_NOT_FOUND` in a deployed function. Both use explicit `.js` specifiers and JSON import attributes for the same reason.

| Endpoint                                         | Purpose                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/indicator?country=&indicator=&year=` | One sourced value + provenance. Deterministic, unauthenticated, edge-cached.                                |
| `GET /api/snapshot`                            | The whole hub (~20 KB gzipped) in one payload, so a client never fetches numbers one at a time.             |
| `POST /api/research`                           | Legacy grounded Q&A over the Data Hub via Claude tool-use. It is frozen as the rollback endpoint.           |
| `POST /api/ask` *(planned)*                  | New bounded Ask CaribEcon path: shared provider roles, deterministic evidence, and deterministic citations. |

### Excel add-in (`excel-addin/`)

A separate npm project (own `package.json`, webpack, deps) — not part of the Astro build. Ships seven read-only `CE.*` custom functions plus a task pane (browse & insert, function reference, Ask).

- **Custom functions must never be `async`.** Excel shows `#BUSY!` for as long as a returned Promise is pending, so they return a value synchronously off the loaded snapshot and a Promise only on a cold runtime. See the header comment in `src/functions/functions.js`.
- The manifest declares a **shared runtime**, so the task pane and the custom functions are one JS context and share one loaded snapshot via `src/shared/hub.js`.
- API host and research token are injected at build time by webpack `DefinePlugin` — never hardcoded, never committed.
- **Publishing:** `npm run build:addin` builds it and copies the output to `public/addin/`, which is committed and served at `caribecon.org/addin/`. Re-run it after any add-in source change, or the deployed add-in silently keeps serving the old bundle. `public/addin` is excluded in `tsconfig.json` — its minified output otherwise exhausts the TS compiler's heap during `astro check`.

## Coding Philosophy

- Working code first; clear over clever; readable by a non-expert (a short comment on every non-trivial function).
- Minimize dependencies; smallest effective change; avoid scope creep.
- Verify any changed page: `node screenshot.mjs <localhost url> [label]` and read the PNG (see `docs/SCREENSHOT_WORKFLOW.md`).
- Git: branch per feature (`feature/<page>`), commit each working increment, consolidate via PR; use Plan Mode for complex tasks.
- **Generated data files & git.** `data/news.json` is owned by the daily CI cron. Run **`npm run news:audit`** to refresh only the selective `news_unclassified.json` review inbox; set a valid `category` + `approved: true`, then run **`npm run promote`** to validate approvals without rewriting `news.json`. Approved news is merged by `dataHub.ts` at build time. Use `npm run feeds` only for testing the full pipeline; discard its `news.json` churn with `git checkout data/news.json` before committing. As a safety net, `.gitattributes` + local merge drivers auto-resolve these files on pull (news → keep incoming CI copy; editorial inboxes → keep local human edits) so a conflict can never leave broken JSON. A fresh clone must re-run the one-time `git config` commands listed at the top of `.gitattributes`.
- Build order: shell + hub built and frozen first; each page scoped to its own files; the main agent consolidates and verifies.

### File ownership

| Domain                      | Key files                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Shell                       | `src/layouts/Shell.astro`, `src/components/shell/*`                                             |
| Design tokens               | `src/styles/tokens.css`, `src/styles/base.css`                                                  |
| Data hub                    | `src/lib/dataHub.ts`, `src/lib/types.ts`, `data/*.json`                                       |
| Charts                      | `src/components/charts/*`                                                                         |
| Home                        | `src/pages/index.astro`, `src/components/home/*`                                                |
| Data                        | `src/pages/data.astro`, `src/components/data/*`                                                 |
| News / Publications / Deals | `src/pages/<page>.astro`, `src/components/<page>/*`                                             |
| Public API                  | `api/indicator.ts`, `api/snapshot.ts`, `api/research.ts`, planned `api/ask.ts`              |
| AI / evidence services      | `src/lib/ai/*` (planned), `src/lib/indicators.ts`, `src/lib/news.ts`, `src/lib/askTools.ts` |
| Excel add-in                | `excel-addin/src/{functions,taskpane,shared}/*`, `excel-addin/manifest.xml`                     |
