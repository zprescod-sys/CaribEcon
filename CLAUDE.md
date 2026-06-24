# CLAUDE.md — Caribbean Macro Almanac

Read at the start of every session to re-ground; update **Current State** and the **Session Log** at the end. This file is the project's orientation map. Two companion docs are authoritative in their own domains — do not duplicate or contradict them here:

- **Design / visual system → `EDDESIGN.md`** — the sole authority on look: color, type, geometry, motion, components, page layout.
- **Data schema & sourcing → `data/SCHEMA.md`** — the canonical record shape, indicator slugs, source tiers, and integrity rules.
- QA workflow → `docs/SCREENSHOT_WORKFLOW.md`.

## What This Is

A multi-page Caribbean macroeconomic research tool with the register of a research institute, not a landing page. Separate pages share one shell and one data hub: 16 economies, 24 macro indicators, budgets, news, publications, deals, and a deferred client-facing chart builder (Analysis).

Bar: a portfolio-grade piece for GitHub and LinkedIn — evidence of connecting a real economic problem to a structured workflow. Credibility and rigor over visual flash; professional and near-perfect.

## Tech Stack (locked)

- **Framework:** Astro — static output, native multi-page.
- **Charts:** D3.js, hand-built and hub-driven (never hardcoded data).
- **Export:** SheetJS (`xlsx`) 0.18.5, dynamic-imported on demand.
- **Hosting:** Cloudflare Pages (Phase 2: Pages Functions for server-side API keys).
- **No dark mode** unless explicitly requested — no color-scheme logic.
- All fonts and visual rules live in `EDDESIGN.md`.

## Data Hub (single source of truth)

Every page reads from one hub; no per-page hardcoded numbers.

- **Canonical dataset:** `data/almanac-data.json` — 24 indicators × 16 countries, full provenance per record. Read through `src/lib/dataHub.ts` (typed by `src/lib/types.ts`); never import the JSON directly in a page.
- **Presentation policy:** `data/indicator-meta.json` — slug-keyed `chartGroup` / `defaultChart` / `order`. `label` and `unit` derive from the records. `dataHub.ts` warns at build if a data slug has no meta entry.
- **Other domain files:** `data/budgets.json`, `news.json`, `publications.json`, `deals.json`.
- **Schema, slugs, source tiers, and the debt-ratio merge rule:** `data/SCHEMA.md` (authoritative).
- **Integrity (summary; full rules in SCHEMA):** every number carries `source` / `vintage` / `type` (`actual | estimate | projection | derived`); prefer primary over comparable sources; show `null` + "Unavailable" rather than guess; flag source divergences in `seriesNote` / `sourceNote`; for news and publications store headline + source + date + link only — never republish bodies.
- Phase 2 (later): a scheduled fetcher replaces the hand-collected static hub.

## Pages

- **Home** — daily briefing (repoints per story) + per-country key-indicators rail + regional indexed-GDP chart + Explore links + recent news. **Built.**
- **Data** — chart explorer (country multi-select, indicator selector, year-in-focus) + CSV/XLSX export + budget pie; FDI and spending-vs-revenue views planned. **Built (V2).**
- **News** — all Caribbean news, country filter chips. *Scaffolded.*
- **Publications** — browsable index (title, summary, type, date, link out); host nothing. *Scaffolded.*
- **Deals & Investment** — headline M&A / FDI list, headlines only. *Scaffolded.*
- **Analysis** — DEFERRED client-facing builder; the hub and chart components are built so they can feed it later.

## Architecture

- The front end is a pure presentation layer — it reads the hub and never calls external APIs directly.
- Any live API keys stay server-side (Cloudflare Pages Function).
- Regenerable / scratch output lives in `/data/` or `/.tmp/`.

## Coding Philosophy

- Working code first; clear over clever; readable by a non-expert (a short comment on every non-trivial function).
- Minimize dependencies; smallest effective change; avoid scope creep.

## Build & Workflow

- Fable 5 does most coding in VS Code; keep these MD files tight and unambiguous.
- Verify any changed page: `node screenshot.mjs <localhost url> [label]` and read the PNG (see `docs/SCREENSHOT_WORKFLOW.md`).
- Git: branch per feature (`feature/<page>`), commit each working increment, consolidate via PR; use Plan Mode for complex tasks.
- Build order: shell + hub built and frozen first; each page scoped to its own files; the main agent consolidates and verifies.

### File ownership

| Domain                      | Key files                                                     |
| --------------------------- | ------------------------------------------------------------- |
| Shell                       | `src/layouts/Shell.astro`, `src/components/shell/*`       |
| Design tokens               | `src/styles/tokens.css`, `src/styles/base.css`            |
| Data hub                    | `src/lib/dataHub.ts`, `src/lib/types.ts`, `data/*.json` |
| Charts                      | `src/components/charts/*`                                   |
| Home                        | `src/pages/index.astro`, `src/components/home/*`          |
| Data                        | `src/pages/data.astro`, `src/components/data/*`           |
| News / Publications / Deals | `src/pages/<page>.astro`, `src/components/<page>/*`       |

## Current State (2026-06-18)

- **Data consolidated to one source of truth.** `almanac-data.json` (249 records, 2167 points, 24 indicators, 16 countries) drives every page via `dataHub.ts`; the legacy `indicators.json` was deleted. `indicator-meta.json` gates which indicators appear in selectors. `debt_to_gdp` was merged into `gross_govt_debt_pct_gdp` (IMF series canonical across countries; BB/BS primary divergence noted in `seriesNote`). Full detail in `data/SCHEMA.md`.
- **Dataset refreshed to most-recent data, current to 2025.** Every comparable series is re-pulled in full from the current World Bank / IMF WEO (April 2026) release — historical values reflect the latest revisions, not the vintage they were first collected at. `gdp_growth` + `inflation` are now IMF WEO across all IMF-member countries (KY/TC/VG stay World Bank; TT growth stays primary MoF). `gross_govt_debt_pct_gdp`/`current_account`/`fiscal_balance` = IMF WEO; all other spine indicators = World Bank WDI. 2024 IMF points are estimates, 2025 projections. Primary national records (TT, GY/BB/JM/BS fiscal, KY ESO) left untouched. Collector/refresh/validator scripts in `.tmp/`; policy in `data/SCHEMA.md`.
- **Home page rebuilt** from the imported Claude Design "Caribbean Almanac v2" mock and aligned to `EDDESIGN.md` (cool petrol-and-gold tokens, hard edges): daily briefing + live key-indicators rail + "Guyana divergence" chart + Explore + recent news, click-to-repoint wired to the hub, content on a single `--paper` surface.
- **Feeds pipeline built (repo side); awaiting sheet go-live.** This realizes the deferred "Phase 2 scheduled fetcher" for News/Publications. RSS-by-Zapier → Google Sheet (two tabs) → `scripts/build-feeds.mjs` (CSV→JSON, validate, editorial gate for pubs) → daily GitHub Action commit (`.github/workflows/feeds.yml`) → host auto-deploy. No API keys; bodies never stored. Tested against `scripts/fixtures/*.sample.csv`. To go live: user shares the sheet public-read + sets repo Variable `SHEET_ID`. Setup: `docs/FEEDS_PIPELINE.md`.

## Next Steps

- **Feeds go-live:** user shares the Google Sheet "Anyone with link → Viewer" and sets repo Variable `SHEET_ID`; then `workflow_dispatch` the feeds Action once to confirm commit + redeploy.
- Build the Deals page (News + Publications are scaffolded and now fed by the pipeline).
- Add FDI and spending-vs-revenue views to the Data page (mirror the budget pie).
- Deferred: deterministic D3 chart builder on `/analysis`.

## Session Log (condensed)

- **2026-06-18** — (1) Imported the Claude Design "v2" mock and reskinned Home to the EDDESIGN petrol-and-gold system; fixed a scoped-CSS bug where the key-indicators rail lost its layout on click-to-repoint (`:global` under `.rail-stats`); flattened the page onto one `--paper` surface. (2) Brought the dataset current to 2025 and refreshed all comparable series to most-recent data via direct World Bank + IMF DataMapper APIs (no vintage-pinning): switched growth/inflation to IMF WEO, re-pulled 176 comparable series (152 historical values updated), preserved primary records (TT/fiscal/KY ESO). Updated stale prose (GY 2022 growth 57.8→63.3%). Validator clean (0 errors).
- **2026-06-17** — Data consolidation: almanac made canonical, `indicators.json` deleted, `indicator-meta.json` added, `debt_to_gdp` merged, `types.ts` extended, `SCHEMA.md` trued-up. Hygiene: removed orphan/dead files; `files/` → `docs/`.
- **2026-06-13** — `almanac-data.json` collected (16 countries); Data page V2 (budget dropdown, per-country XLSX export, CountrySnapshot metric-card grid).
- **2026-06-11** — Data-page visual refinement (ticker derived from hub; CountrySnapshot + CountryCarousel; LineChart and BudgetPie upgrades).
- **2026-06-10** — Project init: Astro + D3 scaffold, shared shell, data hub, page stubs.
