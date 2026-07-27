# Budget-pie sourcing audit

Opened 2026-07-26.

**Status: TT, GY and JM are live on sourced figures. BB, BS and KY are removed
from the site** until their per-segment breakdowns can be sourced — the Data-page
dropdown derives from `data/budgets.json`, so omitting an entry removes its pie.

Shipped alongside: local-currency-only amounts (no FX layer), computed rather
than stored percentages, `derived` flags on residuals, an explicit denominator +
basis + coverage disclosure on each pie, and a per-country **audit table export**
(`src/lib/budgetExport.ts`) carrying every published line item with its source
page — including the rows the pie rolls up for legibility.

## Why this exists

A review of the Data-page budget pies found that the per-segment splits in
`data/budgets.json` are **not sourced**. They are scaffold placeholders that have
never been replaced with figures from an official budget document, yet they are
published on `/data` under a hyperlink to each country's Ministry of Finance.

### Evidence

1. Every `pct` in all six budgets is a **whole integer**.
2. Every `pct` vector sums to **exactly 100**.
3. Every per-segment `value` is reproducible as `round(pct × totalUSD / 100)`
   (max relative deviation 0.64%). The only independent inputs are `totalUSD`
   and the integer `pct` vector — there are no sourced line items.
4. The GY and TT `pct` vectors are **byte-identical to the initial scaffold
   commit** `d40e7f6 "Initialize Caribbean Macro Almanac"`. They have never been
   revised against a source.

Genuine functional-classification allocations across six independent national
budget documents do not land on round integers summing to exactly 100.

### The splits are also materially wrong

Trinidad & Tobago, checked against the official Budget Statement 2025
(converting the hub's USD back at its own stored FX rate):

| Segment | CaribEcon publishes | Official | Error |
|---|---|---|---|
| Education | TT$9.58bn | **TT$7.512bn** | +27.5% |
| National Security | TT$7.66bn | **TT$6.113bn** | +25.3% |
| Health | TT$7.66bn | **TT$7.571bn** | ≈ ok |

CaribEcon also ranks **Education** as the largest ministry; officially **Health** is.
The hub's TT total (`originalTotal` 63,860 TT$ mn) **appears nowhere** in the
official document — the stated total expenditure is **59,741 TT$ mn**.

### Decision

Source real per-segment allocations from official documents for all six
countries, with page-level citations. **Any country that cannot be sourced gets
its pie pulled rather than estimated.**

---

## TT — Trinidad & Tobago — FY2025 (Oct 2024–Sep 2025) — ✅ SOURCED

**Budget Statement 2025**, Ministry of Finance, delivered 30 Sep 2024. 179pp.
`https://www.finance.gov.tt/wp-content/uploads/2024/09/Budget-Statement-2025-FINAL.pdf`
Printed folios run 1 lower than the PDF page index; PDF index cited below.

Totals — PDF p.151: Total Revenue $54.224bn · **Total Expenditure $59.741bn** ·
Fiscal Deficit $5.517bn (2.91% of GDP).

"The major Fiscal 2025 allocations will be:" — PDF p.152:

| Segment | TT$ bn |
|---|---|
| Education and Training | 7.512 |
| Health | 7.571 |
| National Security | 6.113 |
| Public Utilities | 3.221 |
| Infrastructure | 1.862 |
| Rural Development and Local Government | 1.771 |
| Transport | 1.410 |
| Agriculture | 1.184 |
| Housing | 0.750 |

Tobago House of Assembly **$2.599bn** — PDF p.148 (recurrent 2.376 · development
programme 0.205 · URP 0.018 · CEPEP 0.0092).

Named sum 33.993bn of 59.741bn → residual **25.748bn (43.10%)**.
The Statement itemises *major* allocations only; this is **not** a complete
functional classification. The residual must be labelled as all other
expenditure incl. debt servicing, transfers and non-itemised ministries.

FX: hub uses 0.1474 USD/TTD (≈6.784 TTD/USD, consistent with the CBTT peg) —
**still needs an explicit cited source + date.**

---

## GY — Guyana — Budget 2024 (calendar year) — ✅ SOURCED (caveats)

**Budget 2024 At A Glance**, Ministry of Finance, 15 Jan 2024. 36pp.
Landing page `https://finance.gov.gy/budget-at-glance-2024/` — returns **403 to
automated fetchers**; a browser user-agent is required (see link-hardening task).
PDF: `https://finance.gov.gy/wp-content/uploads/2024/01/Budget%20At%20A%20Glance%202024.pdf`
Printed folios are inconsistent → cite PDF page index.

Total — PDF p.4: "**$1.146 TRILLION**" = 1,146,000 G$ mn.
(Hub currently stores 1,147,000 — 1,000 G$ mn too high.)

| Segment | G$ bn | PDF p. |
|---|---|---|
| Transport Infrastructure | 204.1 | 33 |
| Education | 135.2 | 14 |
| Health | 129.8 | 12 |
| Agriculture and Food Security | 97.6 | 23 |
| Security Sector | 90.6 | 28 |
| Housing | 78.0 | 15 |
| Human / Social Services | 48.3 | 20 |
| Water and Sanitation | 22.5 | 16 |
| Amerindian & Hinterland Development | 9.0 | 22 |
| Culture, Sports and the Arts | 7.3 | 18 |
| Justice Sector | 6.8 | 26 |

Named sum **829.2bn** of 1,146.0 → residual **316.8bn (27.64%)**.

**Nested figures deliberately excluded** (verified by reading section structure,
not assumed — including them would double-count):
- $30.3bn **Guyana Police Force** (p.28) is a subset of the $90.6bn Security Sector.
- $72.3bn **Drainage & Irrigation** (p.25) sits inside the $97.6bn Agriculture section.

FX — **open**. Hub's 0.00476 USD/GYD implies 210.08 GYD/USD, but its stored
`totalUSD` 5,242 implies 218.8 GYD/USD. Neither is sourced; Bank of Guyana
mid-rate is ≈208.5. This is the long-documented "GY budget conversion 4.2% off".

---

## JM — Jamaica — FY2024/25 (Apr 2024–Mar 2025) — ✅ SOURCED (best quality)

**The Citizens' Guide to the 2024/2025 Budget**, Ministry of Finance & the Public
Service. PDF p.21 carries a **complete ministry-level table that foots exactly**.
`https://www.mof.gov.jm/wp-content/uploads/citizens_guide_to_the_budget-publication_2024_WEB-1.pdf`

### Three candidate denominators — confirms the multi-denominator concern
- **849.9** J$bn — non-debt expenditure (the ministry table's own total; p.7, p.21)
- **1,023.7** J$bn — total expenditure excl. amortisation. This is what
  `budgets.json` *and* almanac `govt_total_expenditure` (1,023,725.2) currently
  use. Check: 1,341.1 − 317.4 = 1,023.7 ✓
- **1,341.1** J$bn — TOTAL EXPENDITURE incl. amortisation (p.8) = recurrent 769.9
  + capital 80.0 + public debt servicing 491.2

Debt servicing 491.2 = amortisation 317.4 + interest 173.8 (p.20).
849.9 + 491.2 = 1,341.1 ✓

**Recommended pie basis:** ministries + "Public Debt Servicing 491.2" over the
**1,341.1** total → an exhaustive partition with **zero residual**.

Ministry allocations, J$ bn ("Total" column, PDF p.21): Finance & the Public
Service 187.1 · Education and Youth 166.4 · Health and Wellness 148.0 · National
Security 137.4 · Economic Growth and Job Creation 39.5 · Science, Energy,
Telecommunications and Transport 27.1 · Local Government and Community
Development 23.0 · Office of the Prime Minister 22.7 · Labour and Social Security
20.1 · Agriculture, Fisheries and Mining 18.0 · Justice 16.3 · Tourism 13.8 ·
Industry, Investment and Commerce 7.2 · Foreign Affairs and Foreign Trade 6.7 ·
Culture, Gender, Entertainment and Sport 5.9 · Houses of Parliament 2.5 ·
Integrity Commission 1.9 · Auditor General 1.4 · Legal and Constitutional Affairs
1.4 · Independent Commission of Investigations 0.8 · Office of the Cabinet 0.7 ·
Governor-General and Staff 0.5 · Office of the Services Commissions 0.5 · Office
of the Children's Advocate 0.4 · Office of the Public Defender 0.4 · Independent
Fiscal Commission 0.3

Stated column totals: 442.0 + 327.8 + 80.0 = **849.9**.
Table carries its own note: "(Slight Variation Due to Rounding of Numbers)".

---

## KY — Cayman Islands — 2024 — ⏳ PARTIALLY SOURCED

**2024 and 2025 Plan and Estimates**, Cayman Islands Government. 432pp.
`https://parliament.ky/wp-content/uploads/2024/07/2024-25-Plan-and-Estimates.pdf`
(live, 200; the `gov.ky` asset-API mirror found in search results **404s**.)

Core Government 2024 (Table 3, PDF p.39, accrual basis):
- Operating Revenue **CI$1,094.872m**
- **Operating Expenses CI$1,033.540m**
- Financing Expenses CI$18.358m · Core Government Surplus CI$42.974m

The hub's stored `originalTotal` of 1,194 CI$ mn matches **neither** figure and
is unsourced.

**Outstanding:** the P&E has no single ministry-summary table. Per-ministry
`APPROPRIATION` blocks appear on ~48 separate pages (75–345) and must be parsed
and mapped to their owning ministry, then reconciled to the CI$1,033.5m operating
total. Note Cayman budgets on an **accrual** basis, unlike the cash-basis
documents used for TT/GY/JM — the denominator note must say so.

---

## BB — Barbados — ⏳ NOT YET SOURCED

Hub currently claims: "Approved Estimates of Revenue and Expenditure 2024/25
(Parliament); functional classification applied to Central Bank of Barbados Table
F1 aggregate" — i.e. it already admits a **crosswalk transformation**, which is
exactly the case most in need of a published audit trail.

---

## BS — The Bahamas — ⏳ NOT YET SOURCED

Hub currently claims: "Budget Communication & Estimates of Expenditure FY2024/25
(Ministry of Finance); Central Bank of The Bahamas QSD Aug-2024".
Hub `sourceUrl` is a bare agency landing page (`bahamas.gov.bs/agencies/finance`),
not a document — insufficient for audit.

---

## Next steps

1. Finish sourcing KY (parse the 48 APPROPRIATION pages), BB, BS.
2. Restructure `data/budgets.json`: per-segment `localValue`, explicit
   `denominator` + `denominatorBasis`, `sourceDocument`, `sourcePage`, FX rate
   with its own source and date, and an explicit `residual` segment.
3. Rebuild the pies off the sourced figures; label the residual honestly and
   stop attributing derived splits to the source document as if transcribed.
4. Ship the downloadable per-pie audit table (country, fiscal year, segment,
   local-currency amount, share, denominator, source document, page).
5. Drop `pct.toFixed(1)` in `BudgetPie.astro` — one-decimal precision on an
   integer guess is false precision.
