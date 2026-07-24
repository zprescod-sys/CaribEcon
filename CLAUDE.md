# CLAUDE.md — CaribEcon

Read at the start of every session to re-ground. This file is the project's orientation map. Two companion docs are authoritative in their own domains — do not duplicate or contradict them here:

- **Design / visual system → `EDDESIGN.md`** — the sole authority on look: color, type, geometry, motion, components, page layout.
- **Data schema & sourcing → `data/SCHEMA.md`** — the canonical record shape, indicator slugs, source tiers, and integrity rules.
- QA workflow → `docs/SCREENSHOT_WORKFLOW.md`.

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

## Coding Philosophy

- Working code first; clear over clever; readable by a non-expert (a short comment on every non-trivial function).
- Minimize dependencies; smallest effective change; avoid scope creep.
- Verify any changed page: `node screenshot.mjs <localhost url> [label]` and read the PNG (see `docs/SCREENSHOT_WORKFLOW.md`).
- Git: branch per feature (`feature/<page>`), commit each working increment, consolidate via PR; use Plan Mode for complex tasks.
- **Generated data files & git.** `data/news.json` is owned by the daily CI cron. Run **`npm run news:audit`** to refresh only the selective `news_unclassified.json` review inbox; set a valid `category` + `approved: true`, then run **`npm run promote`** to validate approvals without rewriting `news.json`. Approved news is merged by `dataHub.ts` at build time. Use `npm run feeds` only for testing the full pipeline; discard its `news.json` churn with `git checkout data/news.json` before committing. As a safety net, `.gitattributes` + local merge drivers auto-resolve these files on pull (news → keep incoming CI copy; editorial inboxes → keep local human edits) so a conflict can never leave broken JSON. A fresh clone must re-run the one-time `git config` commands listed at the top of `.gitattributes`.
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

## Current State (2026-07-17)

- **Coverage expanded to 19 economies + full data health check.** Added **Haiti (HT), Aruba (AW), Curaçao (CW)** — now 17 of the 19 CDB Borrowing Member Countries plus Curaçao and Aruba (`almanac-data.json` = 284 records, 19 countries). HT/AW are in IMF WEO (full comparable spine); CW is not in WEO (World Bank spine only — debt%/current-account/fiscal absent, since CBCS reports them only union-level / current-budget, not comparably). A full source-verification health check (see `audit/claude/`) re-pulled every comparable WB/IMF series against live sources: fixed a Suriname FDI sign error (2021–24 were negative, source is positive), refreshed 184 stale points, re-mapped `confidence` (was 191 flagged defaults → now 68 primary=high / 216 verified-comparable=medium / 0 flagged), and documented all derived series (GY/JM accounting identities verified numerically). Frontend updated: `COUNTRY_NAMES`, 3 flag SVGs, `LineChart` colors, methodology map + CDB framing, "19 economies" copy, `build-feeds` country set. Open follow-ups: GY 2024 budget conversion is 4.2% off (needs source figure); Curaçao debt/CA/fiscal pending a properly-sourced CBCS/Article-IV series.
