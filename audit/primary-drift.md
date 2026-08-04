# Primary-source drift report

Cross-checks hand-keyed **primary** records against live World Bank WDI data (frontier 2015–2026).
These values are **not** changed automatically — this is a to-do list of national figures worth re-checking by hand.

- Primary records: **68** · cross-checked: **8** · **flagged: 3** · not cross-checkable: 60
- Thresholds: >1pp for %-unit indicators, >5% relative for levels.

## ⚠ Flagged — primary value diverges from World Bank

### TT · unemployment (%)
Source: T&T Ministry of Finance — Review of the Economy 2025 (CSO) — https://www.finance.gov.tt/category/economic-review/

| Year | Stored (primary) | Comparable (World Bank) | Δ |
| ---- | ---- | ---- | ---- |
| 2020 | 5.6 | 4.21 | +1.39 pp |
| 2024 | 5 | 3.32 | +1.68 pp |

### TT · labour_participation (%)
Source: T&T Ministry of Finance — Review of the Economy 2025 (CSO) — https://www.finance.gov.tt/category/economic-review/

| Year | Stored (primary) | Comparable (World Bank) | Δ |
| ---- | ---- | ---- | ---- |
| 2019 | 57.4 | 60.69 | -3.29 pp |
| 2020 | 55.9 | 58.64 | -2.74 pp |
| 2021 | 54.8 | 57.63 | -2.83 pp |
| 2022 | 55 | 58.35 | -3.35 pp |
| 2023 | 55.6 | 59.27 | -3.67 pp |
| 2024 | 55.1 | 58.15 | -3.05 pp |

### TT · dependency_ratio (%)
Source: T&T Ministry of Finance — Review of the Economy 2025 (CSO) — https://www.finance.gov.tt/category/economic-review/

| Year | Stored (primary) | Comparable (World Bank) | Δ |
| ---- | ---- | ---- | ---- |
| 2024 | 42 | 43.14 | -1.14 pp |

## Not cross-checkable (no comparable equivalent)

These primary series have no clean World Bank counterpart, so they can only be verified against the national source manually. (Debt-ratio and current-account series previously cross-checked against IMF WEO are included here: the pipeline no longer fetches the IMF, so they are confirmed by hand against the national source.)

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
- GY · current_account
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
- TT · current_account
- TT · fiscal_balance
- TT · govt_capital_expenditure
- TT · govt_current_expenditure
- TT · govt_revenue_total
- TT · govt_total_expenditure
- TT · gross_govt_debt
- TT · gross_govt_debt_pct_gdp
- TT · net_govt_debt
- TT · primary_balance

