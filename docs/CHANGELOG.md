# CHANGELOG — CaribEcon

Project history, moved out of `CLAUDE.md` to keep that file a lean orientation map rather than a
growing log every session has to load. This file is read on demand, not automatically — reach for
it when you need the *why* behind a past decision (a migration, a rebuild, a fix) that isn't
obvious from the current code.

Most recent first.

## Excel add-in: `#BUSY!` eliminated, real task pane, research endpoint (2026-08-08)

**The `#BUSY!` problem.** Excel renders `#BUSY!` in a cell for exactly as long as a custom
function's returned Promise is pending. Every `CE.*` call was one HTTPS round-trip to
`/api/indicator` (~300–430 ms measured against production), with no client cache, no batching and
no in-flight dedup — so a cell flashed `#BUSY!` on first entry, on fill-down, on every recalc and
on every workbook reopen, and a 20×10 grid was 200 requests throttled into waves.

The fix was not caching or batching. **The entire indicator dataset is 2,742 points across 284
series and compresses to ~20 KB** — smaller than a web font — so there was never a reason to fetch
it one number at a time. New `GET /api/snapshot` serves the whole hub as one lean payload
(positional point tuples, provenance retained); the add-in fetches it once at module evaluation,
which under the shared runtime is when the workbook opens. Two consequences:

- The exported custom functions **stopped being `async`**. An `async` function always returns a
  Promise, so even an instant cache hit flashed `#BUSY!`. They now return a value synchronously
  off the loaded snapshot, and a Promise only on a cold runtime. This is the whole fix, and it is
  why nothing in `functions.js` may be made `async` again.
- Verified against the built (minified) bundle: a 200-cell grid costs **0 requests** beyond the
  single snapshot fetch, down from 200. If `/api/snapshot` fails, every function falls back to the
  old per-call `/api/indicator` path, so the worst case is the previous behaviour, not a break.

**New functions, free once the data was local.** `CE.SERIES` spills a whole time series as two
columns (null years omitted, never zero-filled); `CE.SOURCE` / `CE.VINTAGE` / `CE.UNIT` expose
provenance that the old `lookup()` was discarding — it returned `data.value` and threw away the
other 11 fields the API sends. Country codes and slugs are now case-insensitive.

**Latent deployment blocker, found and fixed.** A production-built manifest pointed at
`caribecon.org/functions.js`, `/functions.json`, `/taskpane.html` and `/assets/icon-*.png` — all
404. `excel-addin/dist/` is gitignored and was never published anywhere, so a sideloaded
production manifest was dead on arrival. Invisible in development because `npm run start`
sideloads the *source* manifest against localhost:3000. Now `npm run build:addin` publishes to
`public/addin/` (committed) and the manifest rewrites to `caribecon.org/addin/`. `public/addin` had
to be added to `tsconfig.json`'s exclude for the same heap reason `excel-addin` already was.

**Task pane** replaced the untouched Contoso boilerplate (it was still titled "Contoso Task Pane
Add-in", with a `run()` that filled the selection yellow): browse & insert with a provenance
footer, two insert modes (static values, or live `CE.*` formulas), and a function/slug reference
that surfaces the genuinely uneven coverage. `src/shared/hub.js` holds the snapshot on `globalThis`
so the pane and the functions — separate webpack entries, one runtime — share a single fetch.
Also deleted `commands.js`, which called `Office.context.mailbox` (Outlook-only) in a Workbook host.

**`POST /api/research`** — grounded Q&A over the hub via Claude tool-use (`list_countries`,
`list_indicators`, `get_series`, `compare_countries`). Citations are recorded from what the tools
actually served, not from the model's prose, so a citation cannot be hallucinated. Verified that it
refuses correctly: asked for Curaçao unemployment (not carried) and Jamaica 2031 (beyond coverage)
it reports the gap and lists what *is* available rather than guessing — the behaviour CariBench
exists to measure. Indicators only for now: news search would mean importing `dataHub.ts`, which is
not nodenext-clean and would throw `ERR_MODULE_NOT_FOUND` in a deployed function (the failure
`f9a654e` fixed); news needs the same lean split `indicators.ts` already has first.

Token-gated via `CARIBECON_RESEARCH_TOKEN`, fail-closed (503 when unset), best-effort per-instance
rate limiting. **The token is readable in the published bundle** — it deters casual scripted abuse
and pairs with the rate limit; it is not authentication and must never guard anything that writes.

## Current State (as of 2026-07-23)

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
- **News classifier moved to an LLM (Claude Haiku 4.5), replacing the regex heuristic as
  primary.** `scripts/build-feeds.mjs` classifies each newly-ingested headline via
  `src/lib/newsClassifierLLM.mjs` (structured-output API call, chunked batching, rubric kept
  in its own tunable file, `src/lib/newsRubric.md`); the verdict
  (`decision`/`category`/`confidence`) is stored once on the record and never recomputed.
  `newsRelevance.mjs`'s old keyword heuristic survives only as the no-key/API-down fallback.
  Deals & Investment detection moved the same way — regex `isDeal()`/`inferDealType()`
  replaced by the classifier's own `deal_status`/`deal_type` judgment, staged into the
  existing `deals_inbox.json` queue unchanged. Both the publish gate (`dataHub.ts`) and the
  category chips (`NewsFeed.astro`) trust the stored verdict, falling back to the heuristic
  only for legacy records with none. Verified live in GitHub Actions (428 items classified
  end-to-end; key never exposed to the browser, only ever a GitHub Actions secret); 3 rubric
  calibration issues found in that run were fixed and locked in as regression fixtures. Cost
  at current volume: ~$1.50–4/month. See Session Log for detail; full plan in
  `docs/news-llm-classifier-plan.md`.
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

- **2026-07-27** — Development-finance lending made a first-class deal type (branch
  `feature/deals-dfi-financing`). **Trigger:** "IDB Invest approves US$500m financing for ANSA
  McAL" was in `news.json` from 2026-07-22 but could never reach the Deals page. **Two
  independent root causes**, both fixed. (1) **No backfill path** — the LLM classifier went live
  2026-07-23 and `classifyNewItems` only ever judges *brand-new* items, so all **1059** stored
  records carried no deal verdict and nothing could re-examine them. (2) **No rule for lender
  financing** — the rubric's `pending` bullet swept up "regulatory approval stage / non-operational
  financing stage", and `DealType` had no slot for a credit facility (`Bond` is a securities
  issuance, not a bilateral facility). **New `Debt` type** added to all three hand-synced
  vocabulary copies (`types.ts`, `build-feeds.mjs`, `newsClassifierLLM.mjs`); `triage-deals.mjs`
  imports `DEAL_TYPES` and the DealsFeed badge is generic, so both picked it up free. **Rubric**
  gained a "whose approval closes the deal" rule — a *lender's own* approval of its facility IS
  the closing, unlike a third party clearing someone else's deal — and the ownership gate was
  widened to admit lending while explicitly excluding **grants / programme disbursements** (capital
  must move for ownership or return). warrenb's gate updated to match. **New
  `npm run deals:backfill`** (`--backfill-deals`): deal-judges stored records with no verdict and
  stages the completed ones, no feed fetch. `deal_status`/`deal_type` are **now persisted on the
  news record**, reversing the original design — that's what makes the backfill idempotent and lets
  future rubric fixes find past mis-judgments (noted as superseded in
  `docs/news-llm-classifier-plan.md`). **Results:** backfill judged 1059 records (27 completed,
  53 pending) and staged 22 new candidates; re-run judges 0 with zero file churn; `news.json` diff
  is deal-fields-only (0 changes to `decision`/`category`, so `/news` is unaffected). Fixtures
  17/17 against the live classifier (3 new + 14 pre-existing, no regressions). warrenb triaged the
  26-row queue: 23 rejected, 3 escalated, 0 auto-published (first-run caution still ACTIVE). The
  ANSA facility (`deal-0038c474`, Trinidad Express canonical; the CNC3 report rejected as a
  duplicate) was drafted, WebFetch-verified, then human-approved — **the first `Debt` deal on the
  page**, `Up to US$500m`, IDB Invest + JICA as lenders. Also corrected SCHEMA.md's deals
  paragraph, which still described the regex miner retired on 2026-07-23. **Open:** warrenb flagged
  4 classifier mis-staging patterns for `tune-news-rubric` — a `Debt`-specific pending miss
  ("lines up"/"proposed" DFI loans, e.g. the JPS US$80m loan whose IDB board vote is 7 Aug),
  bulk operational news staged `completed` post-backfill, caribank.org procurement notices, and an
  asking price read as a closed price. Two escalations await a human: the Dominica Cable Car row
  (also has `country: ALL` when the project is in DM) and the West Indian Traders SME listing
  (source gives an offer target, not the amount raised, and an unqualified `$`).
- **2026-07-23** — World Bank/IMF source migration (`docs/worldbank-imf-migration-plan.md`,
  branch `feature/worldbank-imf`; done in 6 commits, one per plan part, walked through
  step-by-step in chat rather than auto-approved). **Root cause:** the weekly `data.yml`
  refresh was failing — the IMF DataMapper API sits behind an Akamai bot-WAF that blocks
  GitHub-runner IPs (403/hang), and IMF terms discourage bulk automated download; WB WDI is
  open (CC BY 4.0) and API-friendly. **Part A** — flipped `gdp_growth`/`inflation` metadata
  for 15 countries × 2 indicators to World Bank, then ran `refresh-data.mjs` to repopulate
  values. **Deviation 1** (caught before committing, not assumed from the plan): the plan
  claimed 19/19 invisible coverage for all 30 records; year-by-year diffing found 4 inflation
  series (BB, SR, KN, AW) with real WB gaps (BB missing 2020-22 actuals mid-spike, SR missing
  2018-19, KN/AW trailing 2-6 years) — held on IMF instead, each with a `seriesNote`. Of the
  remaining 26, 3 more lost only a bare 2025 IMF *projection* with no WB actual yet (BS
  growth/inflation, AW growth) — flipped anyway on user sign-off, since 23/26 already had a
  2025 WB *actual* and holding would have frozen those 3 records against ever receiving the
  real 2025 figure. Net: 26 flipped, 4 held (41 IMF records total incl. debt/fiscal/CA).
  **Part B** — stripped the IMF prefetch/branch from `refresh-data.mjs` and
  `check-primary-drift.mjs` entirely (verified: 12s run, 0 `imf.org` refs, 172 refreshed + 41
  held = 213 = exact pre-migration total); `sources.mjs` IMF helpers kept for manual
  local top-ups only; `data.yml` cadence weekly → monthly (user's call: WB revises on a
  rolling basis, not IMF's fixed cycle, so monthly beats bimonthly at no extra CI cost).
  **Part C** — rewrote the methodology "relies primarily on IMF WEO" copy, SCHEMA.md sourcing
  rules, and this file; along the way corrected two stale claims that would have contradicted
  the new data (TT `gdp_growth` was never actually primary/MoF despite a SCHEMA line saying
  so — schema drift, not this migration's doing; HT/AW's old "full IMF comparable spine"
  description). **Part D** — checked all 5 records finding D named before touching anything:
  4 already had the derivation note the plan wanted (no-op). The 5th, `BB/gross_govt_debt`,
  was the one real gap — **deviation 2**: verified the plan's proposed formula
  (`gross_govt_debt_pct_gdp × nominal_gdp`) numerically first and it did NOT tie out (2-9%
  off); the actual source is CBB's own debt ratio × CBB's own GDP estimate, a different base
  than this hub's WB-sourced `nominal_gdp` — confirmed independently via
  `gross_govt_debt_pct_gdp`'s own `seriesNote`. Documented the correct formula instead of the
  plan's literal text. **Part G** — normalized 4 TT WB `sourceUrl`s from the human
  `data.worldbank.org` portal form to `api.worldbank.org` (all 4 verified returning real
  data); live-checked all 241 unique source URLs across almanac/budgets/publications
  (Python+urllib — `xargs` choked on this shell's env size), found 42 `imf.org` 403s
  (bot-WAF, expected/out of scope) + 8 genuine dead links matching the audit's list exactly,
  researched and verified a live replacement for all 8 (GY/TT/BB/BS budget pages, 2 WB
  country reports, ECLAC Caribbean survey, CDB AR2023) — none left over. **Verification**:
  all 6 plan checks passed — idempotent refresh (0 imf.org calls, 0 values changed on
  re-run), drift report puts TT debt%/current-account under "not cross-checkable" as
  intended, validator 0 errors throughout (same pre-existing BB/2020 debt-ratio warning),
  build clean, and Puppeteer-verified the GDP Growth chart now reads "Source: World Bank —
  World Development Indicators" while the debt chart still reads "IMF World Economic Outlook
  (DataMapper)" for the comparable countries. **Out of scope** (per plan): finding F (Guyana
  2024 budget 4.2% gap, needs the real source figure), Curaçao debt/CA/fiscal (needs a sourced
  CBCS/Article-IV series), and the news-classifier WIP branch cleanup.
- **2026-07-23** — News classifier rebuilt on Claude Haiku 4.5, replacing the regex heuristic
  as the primary decision-maker (branch `new-news`; built step-by-step in chat with explicit
  confirmation at each step, not auto-approved). **Classifier**
  (`src/lib/newsClassifierLLM.mjs`) sends each newly-ingested headline to Haiku 4.5 with a
  structured-output schema — the category `enum` is built directly from
  `NEWS_CATEGORY_GROUPS`, so the model can't return a category the rest of the app doesn't
  understand; chunked batching keeps `max_tokens` bounded. The editorial system prompt lives
  in its own tunable file, `src/lib/newsRubric.md` (publish/review/drop rules, category table,
  worked examples), not embedded in code — `thinking`/`effort` are unsupported on Haiku 4.5
  and deliberately omitted. The old regex heuristic (`newsRelevance.mjs`) survives only as the
  no-key/API-down fallback, never the primary path when a key is present. **Deals detection**
  moved the same way: regex `isDeal()`/`inferDealType()` (removed from `build-feeds.mjs`)
  replaced by the classifier's own `deal_status`/`deal_type` judgment, staged into the
  existing `deals_inbox.json` queue unchanged. **Wiring**: `dataHub.ts`'s publish gate and
  `NewsFeed.astro`'s category chips both now trust a record's stored `decision`/`category`
  first, falling back to the live heuristic only for legacy records with neither — a real
  chip-display bug here (chips silently ignoring the stored verdict) was only caught by
  loading `/news` in a browser, not by any automated check. **Verified live**: a real GitHub
  Actions run classified 428 new items end-to-end (secret masked in logs, key never exposed
  to the browser); 3 rubric over-inclusion cases found in that run were fixed and locked in as
  regression fixtures (`newsClassifier.fixtures.mjs`, 12/12 passing, no regressions). Cost at
  current volume: ~$1.50–4/month. Full architecture in `docs/news-llm-classifier-plan.md`;
  skills-scope notes (a `tune-news-rubric` workflow, and a scoped-but-not-yet-built
  `triage-review-deals` skill) in `docs/news-skills-scope.md` / `docs/deals-skill-scope.md`.
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
