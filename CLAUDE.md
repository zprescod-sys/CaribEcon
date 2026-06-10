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
- **Do NOT use**: rounded corners anywhere except pure circles (legend dots, pie segments, live chart point)

## Build Setup

Fable 5 does the majority of coding in VS Code. These MD files brief Fable — keep them tight and unambiguous.

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

- 2026-06-10: Project initialized. Astro + D3 scaffolded. Design tokens, base styles, shell, data hub (types + Phase 1 JSON), and all page stubs built. Ready for page-level work.

## Next Steps

- Verify `astro dev` runs cleanly with all stubs
- Build Home page (DailyBriefing + RegionalChart)
- Build Data page (LineChart + BudgetPie + ChartControls + StatCards + CSV export)
- Build News, Publications, Deals pages
- Commit each page as working increment

## Session Log

### 2026-06-10 — Project initialized
- Git init; Astro + D3 scaffolded
- Design tokens and base styles written from DESIGN_SYSTEM.md
- Shared shell (Shell.astro, TopBar.astro, Nav.astro) built
- Data hub: types.ts, dataHub.ts, all five data/*.json files populated (Phase 1: GY + TT, 2018–2024)
- All five page stubs (index, data, news, publications, deals) and component skeletons created
- CLAUDE.md moved to root; tech stack, data sources table, session log added
