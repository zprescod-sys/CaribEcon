# CaribEcon — Updated Dataset for Review (GATE 2)

**Candidate file:** `audit/claude/almanac-data.candidate.json` (NOT yet applied to `data/almanac-data.json`)
**Change manifest:** `audit/claude/change-manifest.json` · **Audit:** `audit/claude/candidate-health-results.json`
**Live hub + Codex's files untouched.** Nothing is committed; no git branch switched.

## Result at a glance

| | Before | Candidate |
|---|---|---|
| Countries | 16 | **19** (+ Haiti, Aruba, Curaçao) |
| Records | 249 | **284** (+35) |
| Points | 2,279 | 2,745 |
| Critical audit issues | 4 | **0** |
| Source-value mismatches (of ~2k compared) | 76 | **0** |
| Confidence: flagged / medium / high | 191 / 5 / 53 | **0 / 216 / 68** |

Online re-audit: every comparable series re-verified against the live World Bank / IMF source — **0 mismatches**.

---

## 1. Health-check fixes applied (existing data)

- **Suriname FDI sign error corrected** (the 4 criticals): 2021–24 flipped from negative to the current WB positives, +2025 added.
  `2021 −132.7→255.8 · 2022 −9.3→254.3 · 2023 −53.1→484.2 · 2024 −37.6→666.1 · 2025 —→2038.5`
- **184 stale points refreshed** to current WB/IMF vintage across 15 countries. Largest: BB `real_gdp`/`nominal_gdp`/`gdp_per_capita` (10 pts each — WB rebasing), LC (7 pts each). Most others are 1-pt 2025 population/FX/dependency revisions. **Primary national records (TT MoF, GY/BB/JM/BS fiscal, KY ESO) were never touched.**
- **Confidence re-mapped** (your approved scheme): 177 verified-comparable → `medium`, 15 primary → `high`. No record is a bare "flagged" default anymore.
- **Derivations documented** (finding D): IMF `fiscal_balance` points carry the formula note; JM `fiscal_balance` / `govt_capital_expenditure` / `primary_balance` got `seriesNote`s. **The GY/JM accounting identities were verified numerically — `total_exp = current + capital` and `fiscal_balance = revenue − total_exp` hold exactly every year** (strong evidence these are not fabricated).
- **Label drift fixed**: new records aligned to existing labels (`Net FDI`, `Fiscal Balance (overall)`).

## 2. New-country coverage (Haiti, Aruba, Curaçao)

Sourced exactly like the existing spine — IMF WEO for growth/inflation/debt%/current-account/fiscal (members), World Bank WDI for the rest; nulls left where the source has no figure (no invented data).

```
indicator                 HT AW CW        HT = Haiti   (14 records — full comparable spine)
nominal_gdp                ●  ●  ●         AW = Aruba   (12 — no WB unemployment/LFP)
real_gdp / gdp_growth      ●  ●  ●         CW = Curaçao ( 9 — see item 3)
gdp_per_capita             ●  ●  ●
population / dependency    ●  ●  ●
inflation                  ●  ●  ●   (AW & CW inflation: AW from IMF; CW WB 2015–19 only)
fx_rate_usd                ●  ●  ●
unemployment / LFP         ●  ·  ·   (WB has none for AW/CW)
fdi                        ●  ●  ●
current_account            ●  ●  ·
fiscal_balance             ●  ●  ·
gross_govt_debt_pct_gdp    ●  ●  ·
```
Haiti and Aruba are in IMF WEO, so they get the full comparable macro+fiscal spine. Curaçao is **not** in IMF WEO (same as KY/TC/VG) → World Bank spine only.

## 3. ⚠️ Decision needed — Curaçao debt / current-account / fiscal

You chose "hand-collect CBCS now," but collecting revealed a **consistency problem**, so I stopped rather than introduce mismatched data:
- **Current account** is published only for the **Curaçao–Sint Maarten monetary union combined**, not Curaçao alone — not comparable to the country-level series everywhere else.
- **Fiscal balance**: CBCS reports the **current-budget** surplus (a different concept from the *overall* balance used for all other countries).
- **Debt%**: Curaçao-specific figures exist (IMF Article IV: 73.5% 2023, 64.7% 2024) but only for recent years, from a different source family (Article IV, not WEO), and the IMF report PDFs are datacenter-IP blocked here so I can't pull a clean 2015–2025 table.

**My recommendation:** ship Curaçao WB-spine-only (9 records) with those three indicators **absent** (exactly how VG omits indicators it lacks), and treat a properly-sourced CBCS/Article-IV series as a later follow-up when the source PDFs are reachable. This keeps the dataset internally consistent. *(Alternatives: include IMF Article-IV debt% for 2023–25 only, clearly labelled; or you supply the CBCS figures.)*

## 4. ⚠️ Unresolved — Guyana 2024 budget (`budgets.json`, separate file)

`originalTotal 1,147,000 × rate 0.00476 = 5,459.7` ≠ stored `totalUSD 5,242` (4.2% off). One field is wrong. I won't guess — **needs the real GY 2024 budget figure** from the source. Not part of `almanac-data.json`; can be fixed alongside or separately.

## 5. Not changed (deliberately)

- 4 TT WB records use the portal URL (unverifiable) and ~9 dead source links — low-severity housekeeping; can fold into the commit if you want.
- BB/2020 debt-ratio divergence — expected and already explained in the record's `seriesNote`.
- News/deals `low_title_source_agreement` — pre-existing editorial, not data errors.

---

## What happens on approval
Apply the candidate to `data/almanac-data.json`, then move to **Phase C** (frontend: `COUNTRY_NAMES`, 3 flag SVGs, "16 economies"→19 copy, methodology map + reframing, LineChart colors, news country codes, SCHEMA/CLAUDE docs) — presented as its own plan before I touch any frontend file. I'll do the git branch + apply only when you confirm Codex is done in the working tree (to avoid a branch switch under it).
