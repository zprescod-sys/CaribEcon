# Primary-source drift report

Cross-checks hand-keyed **primary** records against live World Bank / IMF data (frontier 2015–2026).
These values are **not** changed automatically — this is a to-do list of national figures worth re-checking by hand.

- Primary records: **68** · cross-checked: **11** · **flagged: 3** · not cross-checkable: 57
- Thresholds: >1pp for %-unit indicators, >5% relative for levels.

## ⚠ Flagged — primary value diverges from World Bank / IMF

### TT · gross_govt_debt_pct_gdp (%)
Source: T&T Ministry of Finance — Review of the Economy 2025 — https://www.finance.gov.tt/category/economic-review/

| Year | Stored (primary) | Comparable (WB/IMF) | Δ |
| ---- | ---- | ---- | ---- |
| 2022 | 74.7 | 69.9 | +4.8 pp |
| 2023 | 81.1 | 78.2 | +2.9 pp |
| 2024 | 83.4 | 81.8 | +1.6 pp |

### TT · current_account (US$ mn)
Source: T&T Ministry of Finance — Review of the Economy 2025 (CBTT) — https://www.finance.gov.tt/category/economic-review/

| Year | Stored (primary) | Comparable (WB/IMF) | Δ |
| ---- | ---- | ---- | ---- |
| 2024 | 1,232.9 | 645 | +587.9 (91.1%) |

### GY · current_account (US$ mn)
Source: Bank of Guyana — Annual Report 2024 (Statistical Annexe) — https://bankofguyana.org.gy/bog/images/research/Reports/ANNREP2024.pdf

| Year | Stored (primary) | Comparable (WB/IMF) | Δ |
| ---- | ---- | ---- | ---- |
| 2015 | -177.4 | -147 | -30.4 (20.7%) |
| 2016 | 27.6 | 65 | -37.4 (57.5%) |
| 2017 | -290.5 | -232 | -58.5 (25.2%) |
| 2019 | -2,823.7 | -3,558 | +734.3 (20.6%) |

## Not cross-checkable (no comparable equivalent)

These primary series have no clean World Bank / IMF counterpart, so they can only be verified against the national source manually:

- BB · capital_account
- BB · fiscal_balance
- BB · govt_capital_expenditure
- BB · govt_current_expenditure
- BB · govt_revenue_total
- BB · govt_total_expenditure
- BB · gross_govt_debt
- BB · import_cover
- BB · monetary_base
- BB · net_govt_debt
- BB · primary_balance
- BS · capital_account
- BS · fiscal_balance
- BS · govt_capital_expenditure
- BS · govt_current_expenditure
- BS · govt_revenue_total
- BS · govt_total_expenditure
- BS · gross_govt_debt
- BS · import_cover
- BS · monetary_base
- BS · net_govt_debt
- BS · primary_balance
- GY · capital_account
- GY · fiscal_balance
- GY · govt_capital_expenditure
- GY · govt_current_expenditure
- GY · govt_revenue_total
- GY · govt_total_expenditure
- GY · gross_govt_debt
- GY · import_cover
- GY · monetary_base
- GY · net_govt_debt
- GY · primary_balance
- JM · capital_account
- JM · fiscal_balance
- JM · govt_capital_expenditure
- JM · govt_current_expenditure
- JM · govt_revenue_total
- JM · govt_total_expenditure
- JM · gross_govt_debt
- JM · import_cover
- JM · monetary_base
- JM · net_govt_debt
- JM · primary_balance
- KY · fiscal_balance
- KY · govt_capital_expenditure
- KY · govt_current_expenditure
- KY · govt_revenue_total
- KY · govt_total_expenditure
- TT · fiscal_balance
- TT · govt_capital_expenditure
- TT · govt_current_expenditure
- TT · govt_revenue_total
- TT · govt_total_expenditure
- TT · gross_govt_debt
- TT · net_govt_debt
- TT · primary_balance

