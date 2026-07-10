# almanac-data.json — schema

The full 24-indicator macro dataset for 16 economies (Montserrat and Anguilla are
in scope but not yet collected — no accessible primary tier). One JSON array; each
element is one (country, indicator) record holding a time series. This is the
*rich* hub for all data on the page. This is the master dataset for macroeconomic indicators used by charts, exports, country profiles, and future analysis features. Other indicator files should not be manually maintained unless they are generated from this file.

**Temporal coverage:** 2015–2025. **Comparable series always reflect the most recent
available data** — when refreshed, the full series (all years) is re-pulled from the
current World Bank / IMF release and overwritten; historical values are NOT pinned to
the vintage at which they were first collected. The `vintage` field on each point
records the source release the value came from (informational), not a freeze.
- `gdp_growth`, `inflation` → IMF WEO (`NGDP_RPCH`, `PCPIPCH`) for all IMF-member
  countries; KY/TC/VG (non-members) stay on World Bank. TT growth stays primary (MoF).
- `gross_govt_debt_pct_gdp`, `current_account`, `fiscal_balance` → IMF WEO.
- All other spine indicators → World Bank WDI.
- 2024 IMF points are `estimate`, 2025 `projection` (latest WEO, vintage `2026-04`).
  World Bank actuals top out at their publication frontier (typically 2024).
- Never mix source families within one series (e.g. don't append an IMF year onto a
  World-Bank-sourced series). Primary national series are left untouched on refresh.

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

TT, GY, BB, JM, BS, BZ, SR, GD, LC, AG, KN, DM, VC, TC, KY, VG (16 collected).
MS (Montserrat) and AI (Anguilla) are in scope but not yet collected.

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
