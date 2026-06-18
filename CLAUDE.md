# CLAUDE.md — Caribbean Macro Almanac

Read this at the start of every session to re-ground context. Update the Session Log and Current State at the end of every session.

## What This Is

A multi-page Caribbean macroeconomic research tool. Multiple economies, seven-plus indicators, budgets, news, publications, deals, and a client-facing chart builder (Analysis page, deferred). Not a landing page — separate pages sharing one shell and one data hub.

Purpose and bar: a portfolio-grade piece for GitHub and LinkedIn — evidence of connecting a real economic problem to a structured workflow. Professional and near-perfect. Credibility and rigor over visual flash.

Initial data scope: Guyana and Trinidad & Tobago, with full structure for adding more countries.

## Tech Stack (locked)

- **Framework**: Astro (static output, native MPA)
- **Charts**: D3.js
- **Hosting**: Cloudflare Pages (Phase 2: Pages Functions for server-side API keys)
- **Fonts**: Bricolage Grotesque / Hanken Grotesk / JetBrains Mono (self-host for production)
- **No dark mode in v1.** Do not add dark mode logic, media queries, or color-scheme toggles unless explicitly requested.
- **Do NOT use**: rounded corners anywhere except pure circles (legend dots, pie segments, live chart point) and the CountrySnapshot metric cards (`border-radius: 8px` — explicit user exception)

## Build Setup

Fable 5 does the majority of coding in VS Code. These MD files brief Fable — keep them tight and unambiguous.

Visual verification: screenshot any changed page with `node screenshot.mjs <localhost url> [label]` and read the PNG. Full workflow + design checklist in `docs/SCREENSHOT_WORKFLOW.md`.

## Data Hub (build first, freeze before pages)

All pages read from one shared data hub, never per-page hardcoded values.

1. Static JSON in `/data/`: `indicators.json`, `budgets.json`, `news.json`, `publications.json`, `deals.json`
2. Loaded once by `src/lib/dataHub.ts`; every page imports from there
3. Schema is frozen before any page sub-agent starts — do not alter schema mid-build

Phase 1 (now): static, hand-collected. Guyana + Trinidad & Tobago, 2015–2024.
Phase 2 (later): scheduled scraper/fetcher replaces static hub.

### Data sources (Phase 1)

| Indicator | Primary Source | Backup Source |
|-----------|----------------|---------------|
| GDP growth, inflation, debt | IMF World Economic Outlook | World Bank WDI |
| Unemployment | ILO ILOSTAT | national statistics offices |
| FDI inflows | UNCTAD World Investment Report | World Bank |
| Budget / revenue | Ministry of Finance (GY, TT) | IMF Article IV |
| News | Stabroek News, Guardian (TT), Caribbean national press | — |
| Publications | IMF eLibrary, World Bank Open Knowledge | — |
| Deals / FDI | Caribbean Business, Caribbean Journal | — |

## Data Integrity (hard requirement)

- Every number tagged with `source`, `vintage`, and `type: actual | estimate | projection`
- Cross-reference two sources where possible; flag material disagreements in `sourceNote`
- Never mix actuals and estimates/projections without visual labels
- Prefer primary sources over aggregators
- Show `null` + "Unavailable" rather than guessing
- News/publications: headline + source + date + link. Never republish bodies

## Pages (one sub-agent each)

- **Home** — story of the day + regional indexed-GDP chart + quick links
- **Data** — chart explorer (country multi-select, indicator selector) + CSV export + budget pie + FDI view + spending vs revenue
- **News** — all Caribbean news, country filter chips
- **Publications** — browsable index (title, summary, type, date, link out); host nothing
- **Deals & Investment** — headline list (M&A, transactions, FDI); headlines only
- **Analysis** — DEFERRED. Client-facing builder. Build hub + chart components to support it later; no sub-agent yet.

## Agent Orchestration Model

1. Main agent plans; divides by page with NON-OVERLAPPING file ownership
2. Shell + data hub built first and frozen before page agents start
3. Each sub-agent gets scoped instructions: its objective, exact files it owns, data keys it reads
4. Sub-agents work in isolation, touching only their own files
5. Main agent consolidates: fixes conflicts, verifies, records cause of any breakage
6. Rule: scope each sub-agent narrowly — minimum context to do its job

## Architecture

- Front end is pure presentation layer — reads data hub, never calls external APIs directly
- API keys stay server-side (Cloudflare Pages Function) for any live calls
- Regenerable output lives in `/data/` or `/.tmp/`

## Coding Philosophy

- Ship working code first, refine later
- Readable by a non-expert: clear names, short comment on every non-trivial function
- Clear over clever; no enterprise patterns
- Minimize dependencies
- Smallest effective change; avoid scope creep

## Git & Workflow

- Main: shell + data hub
- Each page: its own branch (`feature/home`, `feature/data`, etc.)
- Consolidate via PR merge
- Commit every working increment as a restore point
- Use Plan Mode for complex tasks
- Update this file end of every session

## File Ownership Map

| Domain | Owner | Key Files |
|--------|-------|-----------|
| Shell | main agent | `src/layouts/Shell.astro`, `src/components/shell/*` |
| Design tokens | main agent | `src/styles/tokens.css`, `src/styles/base.css` |
| Data hub | main agent | `src/lib/dataHub.ts`, `src/lib/types.ts`, `data/*.json` |
| Charts | shared / main | `src/components/charts/*` |
| Home page | home sub-agent | `src/pages/index.astro`, `src/components/home/*` |
| Data page | data sub-agent | `src/pages/data.astro`, `src/components/data/*` |
| News page | news sub-agent | `src/pages/news.astro`, `src/components/news/*` |
| Publications page | pubs sub-agent | `src/pages/publications.astro`, `src/components/publications/*` |
| Deals page | deals sub-agent | `src/pages/deals.astro`, `src/components/deals/*` |

## Current State

- 2026-06-17: **Single source of truth.** `data/almanac-data.json` is now the canonical indicator hub for every page (the old 7-indicator `indicators.json` was deleted). 249 records, 16 countries, 24 indicators. `dataHub.ts` reads it; charts, ticker, snapshots, and the XLSX export all draw from the same file, so on-screen and exported numbers can no longer diverge. Presentation policy (`chartGroup`/`defaultChart`/`order`) lives in new `data/indicator-meta.json` (slug-keyed, not on records); `dataHub.ts` warns at build if a data slug lacks a meta entry. `getFeaturedIndicators()` gates the chart selector to the 5 cross-country-comparable indicators. `debt_to_gdp` merged into `gross_govt_debt_pct_gdp` (IMF WEO series canonical across all 13 countries; BB/BS primary divergence noted in `seriesNote`). `sourceTier` vocab is now `primary | comparable`. `types.ts` `IndicatorSeries` carries the full provenance fields. RegionalChart de-hardcoded (reads `real_gdp` from the hub, base year 2021).
- 2026-06-13: feature/data-extraction merged to main. `data/almanac-data.json` collected (originally 254 records; see SCHEMA.md). Data page V2 live: budget country dropdown (data-driven), per-country XLSX export (4-sheet SheetJS workbook), CountrySnapshot redesigned as metric-card grid. `src/lib/almanacExport.ts` handles the export logic. SheetJS 0.18.5 added to package.json.

## Next Steps

- Build Home page (DailyBriefing; bring RegionalChart up to the Data-page chart standard)
- Build News, Publications, Deals pages
- FDI and spending-vs-revenue views on Data page (mirror the budget treatment)
- Non-AI deterministic D3 chart builder on /analysis (user confirmed this approach)
- Commit each page as working increment

## Session Log

### 2026-06-17 — Data consolidation: one source of truth
- Diagnosed a two-dataset split: `indicators.json` (7 indicators, IMF/WB) drove the live charts while `almanac-data.json` (24 indicators, primary) only fed the export — different slugs, so displayed vs exported numbers could diverge. Chose almanac as canonical; deleted `indicators.json`.
- Schema↔data reconciliation: merged `debt_to_gdp` → `gross_govt_debt_pct_gdp` (caught that 8 ECCU countries had ONLY `debt_to_gdp` and JM's primary `gross_govt_debt_pct_gdp` was empty — a blind delete would have wiped debt data; resolved by standardizing on the IMF WEO comparable series across all 13, BB/BS divergence preserved in `seriesNote`). Renamed `sourceTier` `fallback`→`comparable` (254→249 records after dropping 5 duplicate primary debt records).
- New `data/indicator-meta.json` (slug-keyed: `chartGroup`/`defaultChart`/`order`); `label`/`unit` still derive from records. `dataHub.ts` repointed to almanac + meta, added `getFeaturedIndicators()` and a build-time drift guard. `types.ts` extended with `sourceTier`/`sourceRef`/`confidence`/`unitNote`/`seriesNote` + `derived` point type. SCHEMA.md trued-up (24 indicators × 16 countries).
- Consumer slug migration: data.astro snapshots (`govt_debt`→`gross_govt_debt_pct_gdp`, `fdi_inflows`→`fdi`), ChartControls dropdown → featured set, almanacExport order list. RegionalChart de-hardcoded — reads `real_gdp` from the hub, indexed to 2021 (almanac's TT data starts 2021); GY oil-boom story preserved via pre-base years rendering below 100.
- Hygiene: deleted orphan `StatCards.astro`, untracked `.DS_Store`, removed dead `macro_dashboard.html` + stale duplicate `files/CLAUDE.md`; `files/` reorganized to `docs/`. Build green, both pages screenshot-verified.

### 2026-06-13 — Data page V2 + 18-country almanac merge
- Sub-agent collected `almanac-data.json`: 254 records, 16 countries, hybrid sourcing (IMF/WB macro spine + primary fiscal for TT/GY/BB/JM/BS/KY). MS and AI absent (no accessible primary tier). Schema frozen in `data/SCHEMA.md`.
- Budget section: data-driven country `<select>` (auto-discovers from budgets.json, defaults T&T). Single BudgetPie shown at a time.
- Per-country XLSX export: `src/lib/almanacExport.ts` (4 sheets: Data + 3 chart-ready tables). SheetJS 0.18.5 (community build, no embedded charts — chart-ready tables instruct user to Insert→Chart). Dynamic import on click.
- CountrySnapshot redesigned: responsive metric-card grid (auto-fit 190px), Lucide icons, `--gold` lead accent, `border-radius: 8px` (explicit exception). Flag guard prevents stray space in header.
- Merge review: BB gross_govt_debt 2019–2023 and BS gross_govt_debt_pct_gdp 2024 annotated with sourceNote explaining GDP-base divergence (CBB/CBOB vs World Bank WDI). Flagged, not forced.

### 2026-06-11 — Data page visual refinement
- TopBar ticker rebuilt: derived from dataHub (was hardcoded), "CC · Indicator value" pattern, superscript est flag, continuous scroll + hover-pause, reduced-motion static row
- New CountrySnapshot.astro (reusable per-country card: lead GDP, supporting indicators, "vs year" deltas, quiet projection flags) + CountryCarousel.astro (pills, 5s ambient auto-advance, any interaction stops it for the session, 250ms crossfade)
- LineChart: stats strip redesigned into country cells + labeled Range block; chart upgraded earlier same cycle with area gradients, crosshair unified tooltip, draw-in animations
- BudgetPie: padAngle 0.015 + cornerRadius 3, synced legend (swatch/name/value/pct), hover lift +6px with 0.4 dim, centre swap, click pins centre + projects panel, two-way legend↔segment hover
- Data page de-boxed: snapshot strip on hairline rules, budget section on --paper-warm band
- StatCards.astro retired from data.astro (file kept)

### 2026-06-10 — Project initialized
- Git init; Astro + D3 scaffolded
- Design tokens and base styles written from DESIGN_SYSTEM.md
- Shared shell (Shell.astro, TopBar.astro, Nav.astro) built
- Data hub: types.ts, dataHub.ts, all five data/*.json files populated (Phase 1: GY + TT, 2018–2024)
- All five page stubs (index, data, news, publications, deals) and component skeletons created
- CLAUDE.md moved to root; tech stack, data sources table, session log added
