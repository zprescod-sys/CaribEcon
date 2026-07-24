# CLAUDE.md — CaribEcon

Read at the start of every session to re-ground; update **Current State** and the **Session Log** at the end. This file is the project's orientation map. Two companion docs are authoritative in their own domains — do not duplicate or contradict them here:

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
- **Hosting:** Cloudflare Pages (Phase 2: Pages Functions for server-side API keys).
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

## Current State (2026-07-23)

- **Automated data pipeline is now World-Bank-only.** The weekly `data.yml` refresh was
  failing: the IMF DataMapper API blocks GitHub-runner IPs behind a bot-WAF, and IMF terms
  discourage bulk automated download. `gdp_growth`/`inflation` moved to World Bank WDI for
  26 of 30 records (13 countries × 2 indicators); 4 inflation series (BB, SR, KN, AW) stayed
  on IMF WEO — hand-maintained — because WB's coverage has real gaps for them (each
  documented with a `seriesNote`). `scripts/refresh-data.mjs` and
  `scripts/check-primary-drift.mjs` no longer call the IMF at all; `gross_govt_debt_pct_gdp`,
  `fiscal_balance`, `current_account` (already IMF-only) join the hand-maintenance list.
  Cadence changed weekly → monthly (`data.yml`, 1st of the month) — WB revises on a rolling
  basis, not IMF's fixed twice-yearly cycle, so monthly beats a fixed bimonthly schedule at
  no extra CI cost. Full sourcing rules in `data/SCHEMA.md`; see Session Log for detail
  including two deviations from the original migration plan (data-verified, not assumed).
- **Coverage expanded to 19 economies + full data health check.** Added **Haiti (HT), Aruba (AW), Curaçao (CW)** — now 17 of the 19 CDB Borrowing Member Countries plus Curaçao and Aruba (`almanac-data.json` = 284 records, 19 countries). HT/AW are in IMF WEO (full comparable spine); CW is not in WEO (World Bank spine only — debt%/current-account/fiscal absent, since CBCS reports them only union-level / current-budget, not comparably). A full source-verification health check (see `audit/claude/`) re-pulled every comparable WB/IMF series against live sources: fixed a Suriname FDI sign error (2021–24 were negative, source is positive), refreshed 184 stale points, re-mapped `confidence` (was 191 flagged defaults → now 68 primary=high / 216 verified-comparable=medium / 0 flagged), and documented all derived series (GY/JM accounting identities verified numerically). Frontend updated: `COUNTRY_NAMES`, 3 flag SVGs, `LineChart` colors, methodology map + CDB framing, "19 economies" copy, `build-feeds` country set. Open follow-ups: GY 2024 budget conversion is 4.2% off (needs source figure); Curaçao debt/CA/fiscal pending a properly-sourced CBCS/Article-IV series.
- **Selective news editorial inbox.** `npm run news:audit` stages only plausible rejected feed items in `data/news_unclassified.json` without rewriting `news.json`. Editors assign a valid category and set `approved: true`; `npm run promote` validates, and `dataHub.ts` merges approved rows into the public feed with explicit category/group overrides.
- **CaribEcon naming and interaction refresh.** Product naming is now CaribEcon throughout. Year in Focus is selection-aware and produces country/indicator/year context, value, regional rank, YoY change, country narratives for Guyana/T&T/Jamaica, statistical fallback copy, and point-level provenance. Deals derive their date range and separate transaction type from institutional status.
- **Live news pipeline (RSS → hub, GitHub Actions).** `scripts/build-feeds.mjs` (`npm run feeds`) fetches the feeds in `data/feeds.json` (19 curated Caribbean outlets + regional), normalises to `NewsItem`, filters to **financial/economic** items (`FIN_RE` lexicon), and **merges** into `data/news.json` as a rolling 120-day archive (full set, not a top-N). Stable `id = slug(source)-sha1(url)`; output idempotent; failing feeds (403/TLS/non-RSS) skipped, not fatal. The `/news` page paginates the whole archive (client-side, 25/page) with country/keyword search; the home page shows the 20 most recent. `.github/workflows/feeds.yml` runs daily (`0 11 * * *`) and commits when changed → host auto-deploys. No Zapier/Sheet (a Zapier design was evaluated and dropped — billed per article). Bot-blocked feeds **removed** (see Session Log 2026-06-27).
- **Publications & Deals are feed-driven (front-end + data).** Both pages now mirror the News page — keyword/country search + client-side pagination (25/page), via `PublicationsFeed.astro` / `DealsFeed.astro`. **Publications** stay editorial-in-the-loop: rows hand-entered into `data/pub_inbox.json` (human fills `summary`/`type`, sets `approved`), promoted into `publications.json` without clobbering curated records. **Deals** are mined from the news set by `buildDeals()` in `build-feeds.mjs` using a deliberately strict filter (a deal-action verb **and** a money figure, or a high-confidence standalone phrase), staged in `data/deals_inbox.json` with a `suggestedType`; a human fills `value`/`parties`, confirms the `DealType`, sets `approved`, and approved rows promote into `deals.json` non-destructively. Policy in `data/SCHEMA.md`.
- **Data consolidated to one source of truth.** `almanac-data.json` (249 records, 2167 points, 24 indicators, 16 countries) drives every page via `dataHub.ts`; the legacy `indicators.json` was deleted. `indicator-meta.json` gates which indicators appear in selectors. `debt_to_gdp` was merged into `gross_govt_debt_pct_gdp` (IMF series canonical across countries; BB/BS primary divergence noted in `seriesNote`). Full detail in `data/SCHEMA.md`.
- **Dataset refreshed to most-recent data, current to 2025** (as of the 2026-06-18 refresh
  described below; superseded for `gdp_growth`/`inflation` sourcing by the 2026-07-23
  World-Bank-only migration above — see `data/SCHEMA.md` for current sourcing). Every
  comparable series was re-pulled in full from the then-current World Bank / IMF WEO
  (April 2026) release — historical values reflect the latest revisions, not the vintage
  they were first collected at. `gross_govt_debt_pct_gdp`/`current_account`/`fiscal_balance`
  = IMF WEO; all other spine indicators = World Bank WDI. 2024 IMF points are estimates,
  2025 projections. Primary national records (TT, GY/BB/JM/BS fiscal, KY ESO) left
  untouched. Collector/refresh/validator scripts in `.tmp/`; policy in `data/SCHEMA.md`.
- **Home page rebuilt** from the imported Claude Design "CaribEcon v2" mock and aligned to `EDDESIGN.md` (cool petrol-and-gold tokens, hard edges): daily briefing + live key-indicators rail + "Guyana divergence" chart + Explore + recent news, click-to-repoint wired to the hub, content on a single `--paper` surface.

## Session Log (condensed)

- **2026-07-17** — Data health check + coverage expansion to 19 economies (branch `analysis/data-verification`; work isolated under `audit/claude/` alongside a parallel Codex audit). (1) **Health check.** Copied the auditor to `scratchpad/claude-audit-data-health.mjs` (relaxed vintage regex to `^\d{4}(-\d{2})?$`; dropped dead `debt_to_gdp` from `pctIndicators`; output to `audit/claude/`), ran `--online` over 249 series: found 4 critical (Suriname FDI sign-flipped 2021–24 vs live WB), ~28 stale GDP-family points (BB `real_gdp` rebasing, LC, AG, GD), 134 derived-without-per-point-note flags (mostly documented at `seriesNote` level), and a 191× `flagged`-confidence collector default. No prose hallucinations (GY 63.3% narrative matches hub). Report: `audit/claude/DISCREPANCY_REPORT.md`. (2) **Fixes (approved).** Re-pulled all comparable WB/IMF → 184 points refreshed to current vintage (primary national records untouched); confidence re-mapped (verified-comparable→medium, primary→high, 0 flagged); IMF `fiscal_balance` + JM records got formula notes; GY/JM identities `total_exp=cur+cap` and `fiscal=rev−totExp` verified exactly. (3) **New countries.** HT (14 records, IMF member spine), AW (12, no WB unemployment/LFP), CW (9, WB-only — not in WEO). Curaçao debt%/current-account/fiscal left **absent** on purpose: CBCS reports them union-level (CUR+SXM) / current-budget, not comparable, and IMF Article-IV PDFs are datacenter-IP blocked. Candidate re-audited: **0 critical, 0 source mismatches**. (4) **Frontend (19).** `dataHub COUNTRY_NAMES`, `ht/aw/cw.svg` flags, `LineChart SERIES_COLORS`, `methodology.astro` (COVERED +Haiti, mapDots +Aruba/Curaçao, CDB framing), index.astro "19 economies", `build-feeds` COUNTRIES, SCHEMA.md, this file. Open: GY 2024 budget conversion 4.2% off (needs source); new-country news RSS outlets deferred; Curaçao 3 indicators pending a sourced CBCS series.
- **2026-07-14** — Data-page interaction + mobile fixes. (1) **Year in Focus is now multi-country.** The country rows the panel already renders (`#yif-headlines`) are clickable/keyboard-activatable and re-point the whole panel — title, narrative, Value/Regional-rank/YoY, provenance badges — to that country for the same year, with a gold left-accent highlight on the pinned row (`LineChart.astro` + `YearInFocusPanel.astro` CSS). `openYearInFocus` gained an optional `focus` arg; a module-scoped `focusCountry` makes the choice sticky across `countries-changed`/`indicator-changed` redraws (falls back to first-selected if the pinned country is deselected). A fresh chart click still resets to the default first-selected country, as before. (2) **Net FDI chart is legible on mobile** (`FDIChart.astro`): margins + axis tick count are now width-aware (`isNarrow = W < 520` → `ML 108/MR 56/3 ticks/11px names` vs desktop `170/90/5 ticks/13px`), mirroring LineChart's responsive idiom. Also fixed a value-label collision: a long negative bar's tip-label used to spill into the country-name gutter, so it now flips **inside** the bar (paper fill) when the tip sits too close to the left edge — improves desktop too. Build clean (6 pages); both fixes verified via Puppeteer (clicked TT → panel repointed with rank 5 of 15; 375px FDI screenshot shows clean axis + no label overlap).
- **2026-07-12** — Added selective `news_unclassified.json` staging, audit-only feed mode, approval validation, and data-hub merge/category overrides. Seeded the ExxonMobil deepwater edge case for editorial review and added regression coverage.
- **2026-07-10** — News-QA hardening + Excel-export cleanup. (1) **Classifier is now title-driven with editorial confidence** (`src/lib/newsRelevance.mjs`): `classifyNews` returns `{category, group, confidence}` — a specific category term in the *title* = `high`, an on-topic title with no specific rule = `medium` (Macro), and a headline whose only economic signal is a *tag* (or none) = `low`/`Unclassified`. New `isDisplayableNews()` = relevant **and** ≥ `MIN_NEWS_CONFIDENCE` (`medium`); it replaces `isRelevantNews` as the gate at both ingest (`build-feeds.mjs`) and render (`dataHub.ts`), so low-confidence items are hidden, never mis-chipped. This kills the "Best Friend Remembers Cody Gomes → Trade" class of bug (off-topic title dragged in by a stray tag). Also: added tribute/remembrance **and death/fatality** terms to `EXCLUDE_RE` (kills "Pensioner found dead in car" — `pension` is an include term but not *strong*, so a death word drops it while a real pension-fund story stays); added insurance to the include-list + Banking rule; moved ports/harbour → Trade, airports → Tourism, mining → Investment to match the category spec. Impact: 227/340 stored items now display (113 noise items — politics/crime/death/sports/school — dropped). (2) **Excel export** (`almanacExport.ts`): dropped the internal **Tier** and **Confidence** columns from the Data sheet and added a `fitColumns()` auto-width pass (all sheets) so nothing clips. Build clean (6 pages); export + classifier verified via node.
- **2026-07-09** — Renamed the product to CaribEcon, rebuilt Year in Focus around live selection context, and corrected/classified Deals.
- **2026-06-27** — Made Publications & Deals feed-driven and pruned dead feeds. (1) New `PublicationsFeed.astro` / `DealsFeed.astro` clone the News search + pagination pattern (25/page, diacritic-folding multi-term search, smart pager); retired `PublicationsIndex.astro` / `DealsHeadlines.astro`. (2) Added `buildDeals()` to `build-feeds.mjs` — mines `news.json` for transactions with a strict filter (`DEAL_VERB_RE` **and** `MONEY_RE`, or a `DEAL_PHRASES` standalone), stages to new `data/deals_inbox.json` with a `suggestedType`, promotes approved rows to `deals.json` non-destructively. (3) Hard-deleted bot-blocked feeds: Dominica News Online (403) + Loop News (invalid `/news/feed`) from `feeds.json`, and the whole IMF `PUB_FEEDS` block from `build-feeds.mjs` (datacenter-IP 403); `buildPublications()` keeps only the editorial promote step. Updated `feeds.yml` commit path (+`deals.json`/`deals_inbox.json`) and `SCHEMA.md`. Verified: `npm run feeds` clean (no dead-feed errors; deal-detector found 1 genuine candidate from 91 financial items — low noise), `npm run build` clean (5 pages), screenshots of `/publications` + `/deals` match News parity. FDI + spending-vs-revenue Data-page views designed but deferred (see Next Steps).
- **2026-06-24** — Built the live news ingestion pipeline: `scripts/build-feeds.mjs` + `data/feeds.json` (21 feeds) + `.github/workflows/feeds.yml` (daily cron) + `rss-parser` dep. Fetches/normalises/validates RSS→`NewsItem`, merges into `data/news.json` with a 90-day window and per-country cap (6) for regional balance; verified idempotent, build clean, `/news` renders. Publications kept editorial via `data/pub_inbox.json` (non-destructive promote). Evaluated then dropped a Zapier+Google-Sheets design (billed per article; more moving parts). Known gaps: Dominica 403, IMF pub feeds block datacenter IPs, Loop News URL invalid — all skipped gracefully.
- **2026-06-18** — (1) Imported the Claude Design "v2" mock and reskinned Home to the EDDESIGN petrol-and-gold system; fixed a scoped-CSS bug where the key-indicators rail lost its layout on click-to-repoint (`:global` under `.rail-stats`); flattened the page onto one `--paper` surface. (2) Brought the dataset current to 2025 and refreshed all comparable series to most-recent data via direct World Bank + IMF DataMapper APIs (no vintage-pinning): switched growth/inflation to IMF WEO, re-pulled 176 comparable series (152 historical values updated), preserved primary records (TT/fiscal/KY ESO). Updated stale prose (GY 2022 growth 57.8→63.3%). Validator clean (0 errors).
- **2026-06-17** — Data consolidation: almanac made canonical, `indicators.json` deleted, `indicator-meta.json` added, `debt_to_gdp` merged, `types.ts` extended, `SCHEMA.md` trued-up. Hygiene: removed orphan/dead files; `files/` → `docs/`.
- **2026-06-13** — `almanac-data.json` collected (16 countries); Data page V2 (budget dropdown, per-country XLSX export, CountrySnapshot metric-card grid).
- **2026-06-11** — Data-page visual refinement (ticker derived from hub; CountrySnapshot + CountryCarousel; LineChart and BudgetPie upgrades).
- **2026-06-10** — Project init: Astro + D3 scaffold, shared shell, data hub, page stubs.
