# almanac-data.json — schema

The full 24-indicator macro dataset for 19 economies — 17 of the 19 Caribbean
Development Bank Borrowing Member Countries, plus Curaçao and Aruba. (Anguilla and
Montserrat remain out of scope — ECCB/UN only, no comparable spine.) One JSON array; each
element is one (country, indicator) record holding a time series. This is the
*rich* hub for all data on the page. This is the master dataset for macroeconomic indicators used by charts, exports, country profiles, and future analysis features. Other indicator files should not be manually maintained unless they are generated from this file.

**Temporal coverage:** 2015–2025. **World-Bank-sourced comparable series always reflect
the most recent available data** — every monthly run, the full series (all years) is
re-pulled from the current WDI release and overwritten; historical values are NOT pinned
to the vintage at which they were first collected. IMF-sourced comparable series are
hand-maintained (see below) and only advance when someone runs a manual top-up. The
`vintage` field on each point records the source release the value came from
(informational), not a freeze.
- **The automated pipeline is World-Bank-only** (`scripts/refresh-data.mjs`,
  `scripts/check-primary-drift.mjs`, run monthly by `.github/workflows/data.yml`). The IMF
  DataMapper API blocks CI-runner IPs behind a bot-WAF and its terms discourage bulk
  automated download, so nothing in CI fetches it.
- `gdp_growth`, `inflation` → **World Bank WDI** (`NY.GDP.MKTP.KD.ZG`, `FP.CPI.TOTL.ZG`) for
  every country **except** four inflation series where WB coverage has material gaps
  (missing/interior years) — `BB`, `SR`, `KN`, `AW` — which stay on **IMF WEO**,
  hand-maintained, each with a `seriesNote` explaining the gap.
- `gross_govt_debt_pct_gdp`, `current_account`, `fiscal_balance` → **IMF WEO**, hand-maintained
  (absent for KY/TC/VG/CW, which are not in WEO; not substituted with non-comparable
  national bases). These, plus the four held inflation series above, are the full
  hand-maintenance list (see the pipeline scripts' headers) — top up from the April/October
  WEO release; nothing else needs manual attention.
- All other spine indicators → World Bank WDI, refreshed monthly.
- IMF-held points keep whatever `type` (`actual`/`estimate`/`projection`) and vintage they
  had at last hand refresh — not advanced automatically. World Bank actuals top out at
  their publication frontier (typically the current year minus one).
- Never mix source families within one series (e.g. don't append an IMF year onto a
  World-Bank-sourced series, or patch a WB gap with an IMF year — flip the whole series or
  hold it, never both). Primary national series are left untouched on refresh.

## Record shape

```json
{
  "country": "TT",                      // ISO-ish 2-letter code (see list)
  "indicator": "nominal_gdp",           // canonical slug from the table below
  "indicatorLabel": "Nominal GDP",
  "unit": "TT$ mn",                      // see Unit column
  "unitNote": "GDP at purchaser prices, current prices",
  "source": "T&T Ministry of Finance — Review of the Economy 2025",
  "sourceOrg": "MoF (T&T)",             // short org tag
  "sourceTier": "primary",              // primary | comparable
  "sourceUrl": "https://www.finance.gov.tt/category/economic-review/",
  "sourceRef": "Appendix 4, GDP at purchaser prices",  // table/section, NOT a guessed page number
  "confidence": "high",                 // high | medium | flagged
  "series": [
    { "year": 2024, "value": 173029.6, "type": "actual", "vintage": "2025-08" }
  ]
}
```

### Field rules

- `value` is `null` when no official figure exists — never guess. Add a
  `sourceNote` on that point explaining the gap, e.g. `"[PENDING — CBTT Monetary Survey]"`
  or `"[DATA UNAVAILABLE — OFFICIAL SOURCE EXHAUSTED]"`.
- `type`: `actual` | `estimate` | `projection` | `derived`. Use `derived` for any
  computed figure and put the formula in `sourceNote`.
- `sourceTier`: `primary` (central bank / stats office / MoF / debt office) or
  `comparable` (IMF / World Bank / Oxford). If no value is found or data is found using sources outside of the scope mark the confidence as flagged and include the source in source ref and source URL
- `sourceRef`: cite the table/appendix/section title and the year column. **Do not
  invent page numbers** — text-extracted PDFs have no reliable pagination.
- `vintage`: YYYY-MM of the source document.
- `seriesNote`: an optional record-level note about the whole series — e.g. a
  source-divergence caveat. Distinct from the point-level `sourceNote`.
- Cross-check where possible (e.g. gross_govt_debt ÷ nominal_gdp ≈
  gross_govt_debt_pct_gdp). Note any divergence in `sourceNote`; flag, don't force.

## Sourcing strategy

For indicators used in regional comparison charts, prefer one comparable source family across all countries for that indicator. Use IMF, World Bank, UN, or another regional/comparable source when it provides broad coverage and consistent methodology.

Use primary national sources for country-specific detail, fiscal/budget data, monetary indicators, and cases where comparable international coverage is unavailable or materially outdated.

Do not silently mix sources inside the same comparison chart unless the `sourceOrg`, `sourceTier`, and `confidence` fields make the difference clear. When mixed sourcing is unavoidable, flag the affected records and explain the difference in `sourceNote`.

Blank values are better than guessed values. Use `null` where no reliable official or comparable source exists.

## Canonical indicator slugs (24)

`chartGroup`, `defaultChart`, and display `order` are **presentation policy, not
measured data** — they live once per slug in `data/indicator-meta.json`, NOT on the
data records. The table below mirrors that file for reference. Use them to decide
which indicators appear in public chart selectors; some records matter for exports
and country profiles but should not be default comparison charts. `dataHub.ts`
warns if a slug in the data has no matching entry in `indicator-meta.json`.

| slug                     | label                             | unit                             | chartGroup       | defaultChart |
| ------------------------ | --------------------------------- | -------------------------------- | ---------------- | ------------ |
| nominal_gdp              | Nominal GDP                       | `<local>` mn                     | macro            | no           |
| real_gdp                 | Real GDP                          | `<local>` mn (constant)          | macro            | no           |
| gdp_growth               | GDP Growth Rate                   | %                                | macro            | yes          |
| gdp_per_capita           | GDP per Capita                    | `<local>`                        | macro            | no           |
| population               | Population                        | persons                          | demographics     | no           |
| inflation                | Inflation Rate                    | %                                | macro            | yes          |
| fx_rate_usd              | USD FX Rate                       | `<local>` per US$                | external         | no           |
| unemployment             | Unemployment Rate                 | %                                | labour           | yes          |
| labour_participation     | Labour Force Participation Rate   | %                                | labour           | no           |
| dependency_ratio         | Dependency Ratio                  | %                                | demographics     | no           |
| fdi                      | Net FDI                           | US$ mn                           | external         | yes          |
| monetary_base            | Monetary Base                     | `<local>` mn                     | monetary         | no           |
| current_account          | Current Account Balance (BoP)     | US$ mn                           | external         | no           |
| capital_account          | Capital Account Balance (BoP)     | US$ mn                           | external         | no           |
| primary_balance          | Primary Balance                   | `<local>` mn                     | fiscal           | no           |
| fiscal_balance           | Fiscal Balance (overall)          | `<local>` mn                     | fiscal           | no           |
| govt_revenue_total       | Government Total Revenue          | `<local>` mn                     | fiscal           | no           |
| govt_current_expenditure | Government Current Expenditure    | `<local>` mn                     | fiscal           | no           |
| govt_capital_expenditure | Government Capital Expenditure    | `<local>` mn                     | fiscal           | no           |
| govt_total_expenditure   | Government Total Expenditure      | `<local>` mn                     | fiscal           | no           |
| gross_govt_debt          | Gross Government Debt             | `<local>` mn                     | fiscal           | no           |
| net_govt_debt            | Net Government Debt               | `<local>` mn                     | fiscal           | no           |
| gross_govt_debt_pct_gdp  | Gross Government Debt as % of GDP | %                                | fiscal           | yes          |
| import_cover             | Import Cover                      | months (and weeks in sourceNote) | external         | no           |

`gross_govt_debt_pct_gdp` is the canonical debt-ratio indicator for charting. The
former `debt_to_gdp` slug has been merged into it: the IMF WEO (comparable) series
is used across all countries so the regional debt chart is methodologically
consistent. Where a primary central-bank ratio diverges (BB, BS), that difference
is recorded in the record's `seriesNote`. Do not reintroduce a separate
`debt_to_gdp` slug.

`<local>` = the country's own currency (TTD, GYD, BBD, JMD, BSD, BZD, SRD, XCD,
KYD, USD-pegged, etc.). Always record local-currency levels in local currency;
FDI, current & capital account follow BoP convention (US$ mn).
Local-currency level indicators are source records, not always chart-comparable across countries. Regional charts should use percentage indicators, per-capita indicators, USD-converted derived fields, or normalized values where comparison is required.

## Country order (codes)

TT, GY, BB, JM, BS, BZ, SR, GD, LC, AG, KN, DM, VC, TC, KY, VG, HT, AW, CW (19 collected).
HT (Haiti), AW (Aruba), CW (Curaçao) added 2026-07. Haiti and Aruba are IMF WEO members
(debt%/current-account/fiscal-balance covered as hand-maintained records per the sourcing
rules above; Aruba's inflation is also held on WEO). Curaçao is not in WEO at all — World
Bank spine only; debt%, current account and fiscal balance are absent, reported only
union-level / current-budget by CBCS.
MS (Montserrat) and AI (Anguilla) are out of scope (ECCB/UN only, no comparable spine).

## budgets.json — schema and integrity rules

Hand-maintained. One entry per country per budget year. **Every amount must be
traceable to a page of an official budget document.**

### Currency: local only, never converted

Amounts are held in the country's own currency, in **millions**, exactly as
printed in the source. No FX conversion is applied and no `exchangeRate` field
exists. Converting would add a derived layer carrying its own provenance burden
for no analytical gain — a budget pie is read one country at a time. (The former
USD figures were also wrong: Guyana's conversion was 4.2% adrift with an
unsourced rate.)

### Entry fields

`country` · `year` · `fiscalYear` (e.g. "FY2024/25 (Oct 2024 – Sep 2025)") ·
`currency` (TTD/GYD/JMD) · `currencySymbol` (what the source prints) ·
`total` (the denominator, local-currency millions) · `denominator` (what `total`
measures) · `basis` (cash vs accrual, budget vs outturn, what is included) ·
`coverage` (exhaustive partition, or major items plus a residual) ·
`source` · `sourceDocument` (full title) · `sourceUrl` · `sourcePage` (page for
`total`) · `vintage` · optional `note` (e.g. reconciliation differences).

### Category fields

`name` · `slug` · `amount` (local-currency millions, as printed) ·
`sourcePage` · optional `derived` · optional `note`.

### Rules

- **No stored percentages.** Shares are computed at render time from `amount`.
  Storing a percentage is what previously let unsourced round-number splits
  masquerade as source figures — every `pct` was an integer, every vector summed
  to exactly 100, and every value was reproducible as `pct × total`.
- **`derived: true` is mandatory** on any segment not printed in the source —
  in practice the residual where a document itemises only major allocations. The
  UI badges these and the export labels them "Derived here — not a published
  line item".
- **Never publish a nested figure alongside its parent.** Guyana's Police Force
  allocation sits inside the Security Sector total, and Drainage & Irrigation
  inside Agriculture; both are documented in `note` and excluded from the
  segment list rather than double-counted.
- **State the denominator explicitly** where more than one is defensible.
  Jamaica has three in the same document: J$1,341,100mn incl. amortisation
  (used here), J$1,023,700mn excl. amortisation (used by the fiscal series), and
  J$849,900mn non-debt expenditure.
- **Disclose reconciliation gaps** rather than absorbing them. Jamaica's segments
  sum to J$1,341,200mn against a stated J$1,341,100mn — the source's own
  rounding, recorded in `note` and surfaced in the export.
- A country with no sourceable per-segment breakdown is **omitted entirely**; the
  Data-page dropdown derives from this file, so omission removes the pie. Never
  estimate a split to fill a gap. KY is currently omitted for this reason: the
  Cayman Plan & Estimates budgets by output groups purchased, publishing neither
  a ministry-total nor a functional classification, so any pie would require an
  invented aggregation. See `docs/budget-sourcing-audit.md`.
- **Reconcile every parse against the source's own stated total** before
  publishing. Two Bahamas parsing errors (a column shift, and six agencies hidden
  by a page watermark) were invisible in the output and caught only by the
  footing check.

## News, Deals & Publications feeds pipeline

`data/news.json` is regenerated daily from RSS/Atom feeds by `scripts/build-feeds.mjs`
(`npm run feeds`), run on a cron by `.github/workflows/feeds.yml`. It is **not**
hand-maintained — edits are overwritten on the next run.

- **Source list:** `data/feeds.json` — `{ country, source, url, insecureTLS? }` per feed
  (one or more curated outlets per country; `country: "ALL"` for regional outlets).
  Set `insecureTLS: true` only for feeds with a broken/expired TLS cert.
- **Record shape:** unchanged `NewsItem` (`id, title, source, date, country, url, tags?`).
  `id` is derived as `slug(source)-sha1(url)[0:8]` (stable, dedupes across runs). Only
  headline + source + date + link are stored — **never article bodies** (`tags` come
  from feed categories). Items failing validation (bad date/url, unknown country) are skipped.
- **Relevance + classification (single source of truth):** the whole policy lives in
  `src/lib/newsRelevance.mjs` and is applied at **both** ingest (`build-feeds.mjs`) and
  render (`src/lib/dataHub.ts`) so the two can never drift. Precision over volume — better
  to drop a borderline story than show one that undermines credibility. Three exported
  pieces:
  - `isRelevantNews(title, tags)` — an economic **include** term must appear; if any
    off-topic **exclude** signal (sport / crime / death / entertainment / human-interest)
    is also present, the item is dropped **unless** a *strong, unambiguous* economic term
    rescues it. (Bare `oil`/`bond`/`business`/`pension` are **not** strong — they co-occur
    with crime/sport/obituaries too easily.)
  - `classifyNews(title, tags)` → `{ category, group, confidence }`. **Title-driven, not
    tag-driven** (a stray "business"/"trade" tag on an obituary must never yield a
    confident chip): a specific category term in the *title* = `high`; an on-topic title
    with no specific rule = `medium` (Macro); a headline whose only economic signal is a
    *tag*, or none at all, = `low`/`Unclassified`. `category` is the fine card chip;
    `group` is the coarse `NEWS_GROUPS` filter-bar bucket (Macro / Energy / Finance /
    Fiscal Policy / Investment / Trade & Tourism).
  - `isDisplayableNews(title, tags)` — the **gate the site actually uses**: relevant **and**
    `confidence` ≥ `MIN_NEWS_CONFIDENCE` (`medium`). Low-confidence items are hidden
    entirely rather than shown with a wrong category. Set `FINANCE_FILTER=0` to disable the
    whole gate at ingest.
- **Merge, not replace — full archive:** each run unions fetched items with the existing
  store by `id`, windows to the last `NEWS_WINDOW_DAYS` (120), and keeps the **entire**
  filtered set (safety bound `NEWS_MAX` 2000), newest-first. A rolling archive, not a
  fixed top-N: the `/news` page paginates all of it; the home page shows the 20 most
  recent. The committed JSON is the durable buffer (CI runners are stateless).
- **Selective editorial review inbox:** rejected stories are not all retained. The
  pipeline stages only plausible edge cases in `data/news_unclassified.json`: stories
  with narrow sector/operator vocabulary, or credible commercial language from a
  business-specific feed. Feed tags alone never qualify a story. Obvious sport, crime, death,
  school and lifestyle noise remains discarded. Run `npm run news:audit` to refresh
  this inbox without touching `news.json`, deals or publications. To approve a row,
  set `category` to a valid public category and `approved` to `true`, then run
  `npm run promote` (validation) or `npm run build`. `dataHub.ts` merges approved rows
  at build time with an explicit category/group override; it does **not** rewrite the
  CI-owned `news.json`. Refreshes update machine suggestions and feed metadata while
  preserving the editor-owned `category` and `approved` fields.
  Valid categories: `Macro`, `Energy`, `Debt`, `Fiscal Policy`, `Inflation`, `Banking`,
  `Investment`, `Trade`, `Tourism`, `Infrastructure`, `Labor`, `Corporate`.
- **Resilience:** a feed that 403s / TLS-fails / returns non-RSS is logged and skipped,
  never crashing the run.
- **Removed / known-blocked feeds:** Dominica News Online (`dominicanewsonline.com/feed/`,
  permanent 403), Loop News (`loopnews.com/news/feed`, not a valid RSS path), and the 13
  IMF per-country news feeds (`imf.org/en/news/rss`, block datacenter IPs) were **deleted**
  rather than left failing each run. To revive any, add a proxied URL (RSS.app / RSSHub) in
  `data/feeds.json` (news) or reinstate an inbox-discovery loop in `build-feeds.mjs`.

**Deals are mined from news (editorial-in-the-loop).** There is no reliable M&A/FDI RSS
source, so `buildDeals()` scans the merged `data/news.json` for genuine transactions using
a deliberately strict filter — a title must name a deal action (`DEAL_VERB_RE`) **and** a
money/scale figure (`MONEY_RE`), **or** contain a high-confidence standalone phrase
(`DEAL_PHRASES`). Candidates are staged in `data/deals_inbox.json` (`approved: false`,
empty `value`/`parties`/`type`, plus a `suggestedType`). A human fills `value`/`parties`,
confirms a valid `DealType`, and sets `approved: true`; the next run promotes approved rows
into `data/deals.json` **without overwriting** existing curated records.

**Publications stay editorial-in-the-loop.** The auto-discovery IMF feeds were removed, so
new rows are hand-entered into `data/pub_inbox.json` as staging rows (`approved: false`,
empty `type`/`summary`). A human fills the editorial `summary`, assigns a valid
`PublicationType`, and sets `approved: true`; the next run promotes approved rows into
`publications.json` **without overwriting** existing curated records. Hand-adding rows
directly to `publications.json` also remains valid.
