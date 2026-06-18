# almanac-data.json — schema

The full 24-indicator macro dataset for 16 economies (Montserrat and Anguilla are
in scope but not yet collected — no accessible primary tier). One JSON array; each
element is one (country, indicator) record holding a time series. This is the
*rich* hub for all data on the page. This is the master dataset for macroeconomic indicators used by charts, exports, country profiles, and future analysis features. Other indicator files should not be manually maintained unless they are generated from this file.

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
| fdi                      | FDI                               | US$ mn                           | external         | yes          |
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
