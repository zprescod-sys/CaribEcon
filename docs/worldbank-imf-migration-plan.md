# Plan — World Bank / IMF source migration + audit fixes D & G

_Status: approved 2026-07-23 · target branch `data/worldbank-only`_

## Context

The weekly `data.yml` refresh is failing in CI because both `refresh-data.mjs` and
`check-primary-drift.mjs` fetch the **IMF DataMapper API**, which sits behind Akamai's
bot-WAF and blocks GitHub-runner IPs (403 / dropped connections → 15-min hang). The IMF
also **prohibits bulk automated download without permission**, so automating IMF pulls is
legally ambiguous. The World Bank WDI is open (CC BY 4.0), explicitly invites API use, and
is not blocked.

**Goal:** move the two comparison indicators that World Bank covers cleanly
(`gdp_growth`, `inflation`) onto the World Bank API, make the automated pipeline
**World-Bank-only**, and keep the three IMF-only indicators (`gross_govt_debt_pct_gdp`,
`fiscal_balance`, `current_account`) as **hand-maintained backend records** (still displayed
with IMF attribution, just no longer auto-fetched). Also close audit findings **D** (missing
derivation notes) and **G** (URL/link hygiene). Guyana-2024-budget (finding F) and Curaçao
debt/CA/fiscal remain deferred for the user to source.

Verified basis: WB vs IMF for growth/inflation = **median 0.03pp** difference, 19/19 coverage
(invisible swap). WB coverage for debt = 3/19, fiscal = 8/19 → not replaceable. current_account
kept on IMF per user decision (WB has 18/19 but several series freeze at ~2017 and lose BVI).

**Target branch:** fresh `data/worldbank-only` cut from an updated local `main` (= origin/main).
Not `new-news` (16 behind origin, carries unrelated uncommitted news WIP).

---

## Part A — Flip `gdp_growth` + `inflation` from IMF → World Bank (30 records)

Records to flip: **15 countries × 2 indicators** — `TT, GY, BB, JM, BS, BZ, SR, GD, LC, AG, KN, DM, VC, HT, AW`
(the `sourceOrg: "IMF WEO"` growth/inflation records). `TC/KY/CW` are already World Bank.

Per record, rewrite the source metadata to match the existing WB record style
(reference shape confirmed from `TC/gdp_growth`):
- `sourceOrg` → `"World Bank WDI"`
- `source` → `"World Bank — World Development Indicators (NY.GDP.MKTP.KD.ZG)"` (growth) / `(FP.CPI.TOTL.ZG)` (inflation)
- `sourceUrl` → `https://api.worldbank.org/v2/country/<ISO3>/indicator/<CODE>?format=json`
- `sourceRef` → `"WDI series <CODE>, retrieved <date>"`
- `confidence` stays `medium`.

**Mechanism:** one-time migration (scratch script) sets the metadata for the 30 records, then
run `node scripts/refresh-data.mjs` locally (WB reachable here) — the WB branch now owns those
records and repopulates their `series` from `NY.GDP.MKTP.KD.ZG` / `FP.CPI.TOTL.ZG`
(`type: actual`, WB vintage). No hand-entered values. Reuses existing `WB` map + `wbFetchMulti`
in `scripts/lib/sources.mjs`.

## Part B — Make the automated pipeline World-Bank-only

- **`scripts/refresh-data.mjs`**: drop the IMF import (`IMF_CODE, prefetchIMF, imfType, imfVintage`),
  the `prefetchIMF` call, the IMF branch in `refreshSeries` (and the now-unused `nominalByYear`
  cache used only for IMF fiscal derivation). In the main loop, records with
  `sourceOrg === "IMF WEO"` are **skipped and tallied as "held (IMF WEO — hand-maintained)"**
  rather than logged as "unmapped." Their `series` are left untouched.
- **`scripts/check-primary-drift.mjs`**: remove `prefetchIMF` import + call and the
  `IMF_DIRECT` map/branch (`comparableByYear`). WB cross-checks unchanged; primary
  `TT/gross_govt_debt_pct_gdp` and `TT`/`GY` `current_account` fall through to
  **"not cross-checkable"** (honest — checked against national sources by hand).
- **`scripts/lib/sources.mjs`**: keep the IMF helpers but add a comment that they are
  **retained for manual/local top-ups only and no longer called by CI** (leaves a clean path
  for hand-refreshing the IMF backend series).
- **`.github/workflows/data.yml`**: rename step "Refresh comparable series (World Bank + IMF)"
  → "(World Bank)"; update the top comment and the PR-body text ("World Bank WDI and IMF WEO…")
  to note IMF fiscal/debt/external series are maintained by hand.

## Part C — Copy + docs

- **`src/pages/methodology.astro` (§ Data Sources, ~lines 230–236):** revise the sentence that
  says the dataset "relies primarily on IMF WEO series" → growth, inflation, and cross-country
  development/labour/FDI come from **World Bank WDI**; **IMF WEO is retained (hand-maintained)
  for general-government fiscal balance, gross public debt, and current-account** where WB lacks
  comparable small-state coverage.
- Leave the broad "IMF · World Bank · UNCTAD · national sources" framing in `Shell.astro:53`,
  `index.astro`, `data.astro:116` — IMF is still a genuine source. The chart source label
  (`LineChart.astro:485` `selectedSeries.sourceOrg`) and the CountrySnapshot "sources" line
  (`data.astro:98`, built from `getSeries().sourceOrg`) are **record-driven → auto-update**; no edit.
- **`data/SCHEMA.md`** + **`CLAUDE.md` "Current State":** record that growth/inflation are now
  WB-sourced, debt/fiscal/current-account are IMF hand-maintained (out of CI), and the pipeline
  is WB-only.

## Part D — Add derivation notes to 5 records (finding D)

Verify each numerically first (as the audit did for GY/JM) — **do not invent a formula**:
- **`HT/fiscal_balance`, `AW/fiscal_balance`** (IMF): copy the **exact** `sourceNote` already on
  the other 9 IMF `fiscal_balance` records — `GGXCNL_NGDP (% GDP) × nominal_gdp ÷ 100`.
- **`BB/gross_govt_debt`** (primary): formula already stated in its `source` → add
  `sourceNote: "Derived = gross_govt_debt_pct_gdp × nominal_gdp ÷ 100 (CBB AR2024 Table 1)"`;
  confirm against stored BB debt% × nominal GDP.
- **`TT/gdp_per_capita`** (primary): check `nominal_gdp ÷ population`; document the confirmed basis
  (or "per-capita from MoF Review of the Economy 2025" if it doesn't tie out exactly).
- **`TT/primary_balance`** (primary): check against TT `fiscal_balance` + interest / revenue −
  non-interest expenditure; document the confirmed relation, else the source-doc basis.

## Part G — URL / link hygiene (finding G)

- **Normalize 4 TT WB portal URLs → api form** (deterministic; codes from each record's `source`):
  - `TT/fdi` → `…/country/TTO/indicator/BX.KLT.DINV.CD.WD?format=json`
  - `TT/monetary_base` → `…/FM.LBL.BMNY.CN?format=json`
  - `TT/capital_account` → `…/BN.TRF.KOGT.CD?format=json`
  - `TT/import_cover` → `…/FI.RES.TOTL.CD?format=json`
- **Dead-link sweep (~9, best-effort + report):** re-check the audit-flagged 404s (GY/BB/TT 2024
  budget links, 2 WB country-report pages, CDB AR2023, ECLAC 2024, 1 Barbados Today item) across
  `data/budgets.json`, `data/publications.json`, and any almanac `sourceUrl`s; replace with a
  working canonical URL where one exists, and **list any that can't be cleanly replaced** for
  manual follow-up (some may be permanent link rot).

---

## Manual-maintenance scope (IMF-only — for your notes)

These records stay on IMF, will **not** auto-refresh, and need hand top-ups (WEO releases
**April & October** only):

- **`gross_govt_debt_pct_gdp` — IMF (14):** GY, BB, JM, BS, BZ, SR, GD, LC, AG, KN, DM, VC, HT, AW
  · TT = primary (MoF) · KY/TC/VG/CW = no record
- **`fiscal_balance` — IMF (10):** BZ, KN, DM, SR, GD, LC, AG, VC, HT, AW
  · TT/GY/BB/JM/BS/KY = primary · TC/VG/CW = none
- **`current_account` — IMF (13):** BB, JM, BS, GD, AG, DM, VC, BZ, SR, LC, KN, HT, AW
  · TT/GY = primary · KY/TC/VG/CW = none

---

## Verification

1. `node scripts/refresh-data.mjs` locally → **no `imf.org` request**; `git diff` on
   `data/almanac-data.json` shows only the growth/inflation flip (metadata + WB values); the
   IMF debt/fiscal/current-account records are byte-unchanged; log reports "held (IMF WEO) : N".
2. `npm run data:drift` → runs WB-only; report lists `TT` debt and `TT`/`GY` current_account as
   "not cross-checkable"; no IMF fetch.
3. `npm run data:validate` → passes (tiers/confidence valid; derived notes present).
4. `npm run build` → site builds.
5. `node screenshot.mjs <local url> data` and read the PNG (per `docs/SCREENSHOT_WORKFLOW.md`):
   a growth/inflation chart shows **Source: World Bank**; a debt/fiscal chart still shows
   **Source: IMF WEO**; the per-country snapshot "sources" line reflects the flip.
6. Eyeball the methodology page copy.

## Out of scope (left for you)

- Finding **F** — Guyana 2024 budget 4.2% discrepancy (needs the real budget figure).
- **Curaçao** debt / current-account / fiscal (deferred; needs a CBCS / IMF Article-IV series).
- Branch cleanup + saving the Haiku news-classifier WIP (handled separately, in chat).
