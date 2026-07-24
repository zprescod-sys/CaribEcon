# CaribEcon — Data Health Check (Phase A)

**Author:** Claude (isolated from Codex's parallel audit)
**Namespace:** all my artifacts live under `audit/claude/` and `scratchpad/`; I did **not** touch `scripts/audit-data-health.mjs` or `audit/data-health-results.json`.
**Method:** own copy of the auditor (`scratchpad/claude-audit-data-health.mjs`, two quirk fixes) run with `--online` — re-fetched World Bank API + IMF DataMapper for every `comparable` record and diffed each stored point against the current source value with correct inverse unit transforms; plus manual cross-check of narrative/prose figures against the hub.
**Coverage:** 249 series / 2,279 points / 16 countries. 1,823 stored points machine-compared to live source; 76 mismatched.

**Headline:** No prose hallucinations found. The substantive issue is **stale comparable values** (World Bank/IMF have revised numbers since collection) plus **schema-hygiene gaps** (undocumented derivations, an over-broad "flagged" confidence default). One genuine data error: **Suriname FDI has the wrong sign for 2021–2024.**

---

## A. CRITICAL — Suriname FDI wrong sign, 2021–2024 (4 points)

Stored `SR/fdi` is **negative** for 2021–2024; the current World Bank source (`BX.KLT.DINV.CD.WD`) is **positive**. 2015–2020 match the source exactly.

| Year | Stored (US$ mn) | Current WB WDI (US$ mn) |
|---|---|---|
| 2021 | **−132.7** | 255.8 |
| 2022 | **−9.3** | 254.3 |
| 2023 | **−53.1** | 484.2 |
| 2024 | **−37.6** | 666.1 |

**Cause:** World Bank revised Suriname's FDI inflows from negative to positive after these values were collected (an older vintage was captured mid-revision during Suriname's currency crisis). Not a fabrication — a stale vintage — but the sign flip makes it materially wrong on the FDI chart today.
**Proposed fix:** re-pull `SR/fdi` from the WB API (the standard `refresh-comparable` path overwrites it with current values).

## B. HIGH — Stale GDP-family values (~28 points, comparable WB series)

`real_gdp` / `nominal_gdp` / `gdp_per_capita` for **BB, LC, AG, GD, BZ** sit 1–6% off current WB WDI. Notably **BB `real_gdp` is systematically ~2–6% low across 2015–2022** — consistent with a World Bank constant-price **base-year rebasing** since collection. The rest are ordinary between-vintage revisions (mostly 2017, 2020, 2023, 2024).
**Proposed fix:** re-pull all comparable WB series → snaps every value to the current vintage. (Matches the project's existing "most-recent, no vintage-pinning" policy.)

## C. MEDIUM — 43 sub-1% GDP revision diffs

Same families (`real_gdp`/`nominal_gdp`/`gdp_per_capita`/`gdp_growth`), all **< 1%** (max 0.98%). Cosmetic rounding/revision drift; cleared by the same re-pull as B.

## D. HIGH (documentation) — 134 derived points with no formula, 15 records

Per `SCHEMA.md`, a `derived` point must carry its formula in `sourceNote`. These don't:

- **9 IMF `fiscal_balance` records** (AG, BZ, DM, GD, KN, LC, SR, VC — comparable): derived = `GGXCNL_NGDP (% GDP) × nominal_gdp ÷ 100`. Uniform formula, just undocumented.
- **6 primary fiscal records** (GY: revenue/current-exp/total-exp/primary-balance; JM: fiscal-balance/capital-exp/primary-balance): typed `derived` from national components — derivation basis needs to be confirmed and documented.

Not fabricated values, but a real integrity-rule gap.
**Proposed fix:** add the formula `sourceNote` to each (uniform string for the IMF set; verify + document the GY/JM primary set).

## E. Confidence-flag semantics (Phase A5 finding) — 191 "flagged", mostly a collector default

`confidence: "flagged"` per SCHEMA should mean *out-of-scope / missing source* — a genuine warning. In practice it's applied to **177 of 181 comparable records** (including clean IMF WEO / WB WDI series that just verified against source) and 14 primary records. Only the 53 primary national records are `high`. So the badge currently carries almost no signal and, where it surfaces in the UI (Year-in-Focus provenance), reads as alarm on perfectly good IMF/WB numbers.

**Recommended re-map (needs your sign-off — it's UI-facing):**
- Comparable series that **machine-verified** against current source → `medium`.
- Primary national records → `high` (most already).
- Reserve `flagged` for records with a genuine gap, unverifiable source, or documented divergence.

## F. MEDIUM — Guyana 2024 budget conversion doesn't tie out

`budgets.json` GY/2024: `originalTotal 1,147,000 GYD mn × exchangeRate 0.00476 = 5,459.7` but stored `totalUSD = 5,242` (**4.2% gap**). One of the three fields is wrong (the implied rate for 5,242 would be 0.004571 ≈ 210 GYD/US$). Needs reconciliation against the GY 2024 budget document.

## G. Housekeeping / low severity

- **BB/2020 debt-ratio divergence** (stored 129.6% IMF vs 118.5% recomputed from CBB level): expected and already explained in the record's `seriesNote` (IMF ratio vs Central Bank of Barbados level, different GDP base). **No action.**
- **4 TT comparable records** (`fdi`, `monetary_base`, `capital_account`, `import_cover`) use the human `data.worldbank.org/indicator/...` portal URL instead of the `api.worldbank.org` form → they can't be machine-verified. **Normalize the URL form.**
- **~9 dead source URLs (HTTP 404):** GY/BB/TT 2024 budget links; 2 WB country-report landing pages; CDB Annual Report 2023; ECLAC 2024; 1 Barbados Today news item. Link rot — update or replace.
- **12 low_title_source_agreement** (news/deals): mostly Searchlight SVG items with thin `<title>` tags — not data errors.
- **70 unavailable fetches**: source-side 403/307/rate-limits (IMF/WB), not stored-data problems.

---

## Proposed remediation (Phase B, pending your approval)

1. **Re-pull all comparable WB/IMF series** to current vintage → fixes A, B, C in one pass.
2. **Add derivation `sourceNote`s** (D) — uniform for IMF fiscal_balance; verify+document GY/JM primary.
3. **Re-map `confidence`** per the agreed scheme (E).
4. **Reconcile GY 2024 budget** (F) — needs the source figure.
5. **Normalize 4 TT WB URLs + fix dead links** (G).

All of the above would land **together with the HT/CW/AW new-country data** as one reviewed dataset update (per your "report first → approve → fix" instruction), on branch `analysis/data-verification`.
