# Build Prompt — Caribbean Macro Almanac

Paste this into VS Code as the kickoff brief. Read CLAUDE.md and DESIGN_SYSTEM.md first; they are the binding contract for architecture and visual style. This prompt says what to build and in what order. Do not restyle away from DESIGN_SYSTEM.md.

## Goal

Build a multi-page Caribbean macroeconomic research tool. Separate pages, one shared shell, one shared data hub. Portfolio-grade: professional and near-perfect, in the hard-edged "sovereign almanac" style (cool paper, petrol-green ink, marine teal, gold signal accent, square corners, Bricolage Grotesque / Hanken Grotesk / JetBrains Mono). Add muted color via tinted section bands and emphasis cards so pages are not flat white — never bright fills. The existing prototype HTML is the look-and-feel reference; reuse its styling and componentry, restructured into multiple pages.

Initial data scope: Guyana and Trinidad & Tobago only, for accuracy. Build every structure so more economies drop in later without rework.

## Order of work (strict)

1. Shell + data hub first, then freeze them.
2. Then one sub-agent per page, in isolation.
3. Then consolidate and run the self-improvement loop.

## Step 1 — Shared shell and data hub (build before any page)

- Shell: top bar (brand left, mono ticker right) + persistent horizontal nav (mono, current page marked with a gold underline). Shared CSS tokens from DESIGN_SYSTEM.md. Max width ~1180px.
- Data hub: a single source of truth in /data that every page reads. Phase 1 is STATIC, hand-collected JSON for Guyana and Trinidad, using the most recent comprehensive year available (target 2024; use 2025/2026 where complete). Suggested files:
    data/indicators.json   time series per country per indicator (gdp, nonoil, inflation, unemployment, fdi, debt, revenue), each value tagged with source + vintage + actual/estimate.
    data/budgets.json      per country per year: total budget + allocation breakdown by category, each category with 1-3 key projects/initiatives.
    data/news.json         articles: title, source, date, country tag, url.
    data/publications.json reports: title, body (IMF/World Bank/etc), type (e.g. Article IV), date, url.
    data/deals.json        headline M&A / transactions / FDI: headline, parties, value (optional), date, country, url.
- A small shared data-access module that loads these once and exposes them to all pages. No page hardcodes data.
- Freeze the shell, tokens, and hub schema before page agents start. Page agents read the hub; they do not change its schema without asking.

## Step 2 — Pages (one sub-agent each, non-overlapping file ownership)

Build five pages this round: Home, Data, News, Publications, Deals & Investment. Analysis is deferred (see below) — no sub-agent for it yet.

Home — daily briefing: one generalist story of the day (title, standfirst, date stamp) + a regional indexed-GDP visual + quick links into each section. Not country-specific.

Data — the core analytical page:
- Chart explorer: country multi-select (one or many, cannot deselect last), indicator selector, interactive line chart (hover index tooltips; click a year -> year-in-focus panel with that year's key event + headlines), stat cards, insight callout.
- CSV export: any current data selection downloads as CSV.
- Budget view: a pie chart with TOTAL budget in the centre; segments are allocation categories; hovering shows value; clicking a segment (or a list under the pie) shows key projects/initiatives for that allocation. Build the same treatment for FDI and for government spending vs tax revenue.

News — shows all Caribbean news by default; filter chips switch to individual countries. Title + source + date + tag, linking out.

Publications — a browsable INDEX of reports from major bodies (IMF Article IV consultations, World Bank, regional institutions). For each: title, issuing body, report type, date, your own one-to-two-sentence summary, and a link to the original on the source site. HOST NOTHING — do not embed or attach the PDFs, and do not reproduce report charts or tables. If a report's data should be visualized, pull the underlying numbers from the World Bank / IMF data portals into the hub and build your own chart. (IMF and World Bank terms are relatively permissive, but linking + summarizing is the airtight, professional approach and avoids any rights question on a public portfolio piece.)

Deals & Investment — headline list of M&A, transactions, and FDI activity. Headlines only, no deep specifics.

Analysis (client-facing) — DEFERRED this round. Do NOT build this page yet. Keep it in the architecture: build the data hub and chart components so they could feed an analysis builder later (where a user picks metrics, countries, years, and chart type, then generates and exports a visualization). Revisit once the general direction is approved.

## Step 3 — Consolidate

Merge page branches onto the shell. Run the self-improvement loop from CLAUDE.md: find anything broken or conflicting between agents' changes, fix it, verify, and note the cause. Confirm every page reads from the hub and nothing kept a private data copy.

## Constraints

- Follow CLAUDE.md data-integrity rules: source + vintage on every number, label estimates vs actuals, link out for news/publications.
- Follow DESIGN_SYSTEM.md exactly for color, type, geometry, motion, and the quality floor (responsive, keyboard focus, aria-labels, reduced-motion).
- Commit every working increment with a clear message.
- Phase 2 (not now): replace the static hub with a scheduled scraper/fetcher that refreshes /data incrementally (daily to weekly) so data goes live without touching page code.

## Planned (note, do not build yet)

- An AI question agent near the data so users can ask questions conversationally, in the same restrained style.
