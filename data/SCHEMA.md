# almanac-data.json — schema (FROZEN)

The full 25-indicator macro dataset for all 18 economies. One JSON array; each
element is one (country, indicator) record holding a time series. This is the
*rich* hub for the new Data-page export and the future Analysis page. The older
`indicators.json` (7 indicators) still powers the current charts and is left
untouched — do not edit it.

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
  "sourceTier": "primary",              // primary | fallback
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
  `fallback` (IMF / World Bank / Oxford). If a fallback is used, set
  `confidence: "flagged"` and name the doc in `source`.
- `sourceRef`: cite the table/appendix/section title and the year column. **Do not
  invent page numbers** — text-extracted PDFs have no reliable pagination.
- `vintage`: YYYY-MM of the source document.
- Cross-check where possible (e.g. gross_govt_debt ÷ nominal_gdp ≈
  gross_govt_debt_pct_gdp). Note any divergence in `sourceNote`; flag, don't force.

## Sourcing strategy (hybrid by indicator)
- **Macro spine** (1–12 below, except fiscal): IMF WEO / World Bank WDI give a
  comparable, fully-verifiable backbone across all 18 — acceptable as `fallback`,
  upgrade to `primary` where the central bank/stats office publishes it.
- **Fiscal & monetary detail** (13–25): primary only (MoF budget/review, central
  bank statistical digest, debt office). Blank + flag where not published.

## Canonical indicator slugs (25)

| slug | label | unit |
|---|---|---|
| nominal_gdp | Nominal GDP | <local> mn |
| real_gdp | Real GDP | <local> mn (constant) |
| gdp_growth | GDP Growth Rate | % |
| gdp_per_capita | GDP per Capita | <local> |
| debt_to_gdp | Debt-to-GDP Ratio | % |
| population | Population | persons |
| inflation | Inflation Rate | % |
| fx_rate_usd | USD FX Rate | <local> per US$ |
| unemployment | Unemployment Rate | % |
| labour_participation | Labour Force Participation Rate | % |
| dependency_ratio | Dependency Ratio | % |
| fdi | FDI | US$ mn |
| monetary_base | Monetary Base | <local> mn |
| current_account | Current Account Balance (BoP) | US$ mn |
| capital_account | Capital Account Balance (BoP) | US$ mn |
| primary_balance | Primary Balance | <local> mn |
| fiscal_balance | Fiscal Balance (overall) | <local> mn |
| govt_revenue_total | Government Total Revenue | <local> mn |
| govt_current_expenditure | Government Current Expenditure | <local> mn |
| govt_capital_expenditure | Government Capital Expenditure | <local> mn |
| govt_total_expenditure | Government Total Expenditure | <local> mn |
| gross_govt_debt | Gross Government Debt | <local> mn |
| net_govt_debt | Net Government Debt | <local> mn |
| gross_govt_debt_pct_gdp | Gross Government Debt as % of GDP | % |
| import_cover | Import Cover | months (and weeks in sourceNote) |

`<local>` = the country's own currency (TTD, GYD, BBD, JMD, BSD, BZD, SRD, XCD,
KYD, USD-pegged, etc.). Always record local-currency levels in local currency;
FDI, current & capital account follow BoP convention (US$ mn).

## Country order (codes)
TT (done), GY, BB, JM, BS, BZ, SR, GD, LC, AG, KN, DM, VC, MS, AI, TC, KY, VG.
</content>
