# triage-review-deals (warrenb) — calibration notes

Persistent record of how strict the `triage-review-deals` subagent's auto-publish / reject /
escalate bar should be. Read in full by the agent before every run; updated by the agent (or a
human) at the end of every run.

**How this file works:** the bar starts at maximum strictness and only loosens from a specific,
named, confirmed miss — never a general relaxation, and never anything that makes publishing a deal
with an unverified figure or wrong parties more likely. Zero tolerance for false positives (a
wrong or unverifiable published deal) always overrides everything recorded here. Each entry should
name the exact pattern being adjusted, not a vague "be more lenient."

**First-run caution status:** `ACTIVE`. Auto-publish is disabled until a human reviews a first
batch and records authorization here (a dated `first-run caution: LIFTED` entry). While active,
would-be-publishes are fully drafted (parties/value/type transcribed from the source) but escalated
for confirmation, not published; operational spending, pending/proposed deals, and duplicates are
rejected as normal.

---

- **2026-07-25** — Seed entry. No adjustments yet, first-run caution ACTIVE. Running at maximum
  strictness: auto-publish (once lifted) only completed capital transactions whose parties and
  value are explicitly stated in the source — transcription, not inference; reject operational
  spending and pending/proposed deals; escalate genuine deals with any unfillable field.
- **2026-07-25 (run 2)** — First-run caution still ACTIVE (no human authorization recorded yet).
  Triaged 10 pending rows: 0 auto-published (correct — caution active), 7 rejected, 3 escalated.
  Only one row (Image Plus/Apex Radiology $620m acquisition of Island Radiology + The Woman's
  Place) fully satisfied all five auto-publish conditions; it was fully drafted (parties/value/
  type transcribed and verified via WebFetch) and held as an escalation purely per first-run
  caution, awaiting the human's first-batch confirmation. A second row (Dolla Financial/Evolve
  Loan Co) is a genuine completed M&A with confirmed parties, but escalated on its own merits
  (independent of caution) because the value fails the transcription test: the source states the
  acquired portfolio's face value (~$700m in loans) but explicitly says the actual purchase price
  was a formula (nominal value minus credit-loss provisions) with no final figure disclosed and
  never labeled "undisclosed" — publishing $700m as deal value would misrepresent price-paid as
  portfolio-size, so it was left blank and escalated instead. A third (TotalTec/aHa JV) escalated
  because WebFetch failed twice (HTTP 307 on bare and www hostnames) and the headline alone can't
  resolve the ownership-vs-operational gate — matches the exact pattern already named in the seed
  entry. No adjustments to the bar itself this run — every reject/escalate call followed the
  seed's strict reading with no exceptions, so nothing here should loosen the bar. Systemic
  pattern confirmed across 3 of 7 rejects this run (Dolphin Cove pending share-purchase
  agreement, TT US$800m bond issue explicitly "proposed", Lexston Guyana mineral-claims LOI): the
  classifier is still mis-staging `pending` (LOI/MOU/share-purchase-agreement-subject-to-
  conditions/"proposed") as `deal_status: completed`, pushing them into this queue as if closed.
  Recommend a `tune-news-rubric` pass on `src/lib/newsRubric.md` § "Deal status" to sharpen the
  completed-vs-pending distinction (LOIs, share purchase agreements pending financing/regulatory
  conditions, and "proposed" issuances should reliably resolve to `pending`, not `completed`).
- **2026-07-27 (run 3 — post-backfill batch, `Debt` type added)** — First-run caution still ACTIVE
  (no human authorization recorded yet). Triaged 26 of 28 pending rows: 0 auto-published (correct —
  caution active), 23 rejected, 3 newly escalated; the 2 rows escalated in run 2 (Dolla/Evolve,
  TotalTec/aHa) were left untouched per the don't-re-litigate rule. Queue was inflated by the
  one-off `deals:backfill` over 1059 stored news records, so the reject share is expected, not a
  signal to loosen. **No adjustments to the bar this run** — no human has confirmed any past
  decision was wrong, so nothing loosens. First exercise of the new `Debt` type and its two
  carve-outs, both of which did real work: (a) *lender's-own-approval closes the deal* — IDB
  Invest's approval of an up-to-US$500m facility for ANSA McAL was judged `completed`/`Debt` and
  fully drafted (held only by caution), while IDB Invest's US$80m JPS loan was **rejected as
  pending** because the source says the IDB board only decides on 7 August and calls it "the
  proposed transaction"; (b) the *grant carve-out* — Starnieuws's "China investeert SRD 245 miljoen"
  is explicitly "volledig gefinancierd door het China Aid-programma", i.e. aid, so `not_a_deal`
  despite the investment framing in the headline. Two further judgment calls worth recording as
  precedent, both made at the strict reading and neither loosening anything: a **broadcast-rights
  licence** (CNC3/CPL) is ordinary commercial contracting, not a `Concession` in the gate's sense;
  and a **loan being fully repaid** (Sir Lester Bird Medical Centre) is debt servicing, not a
  financing extended — `Debt` covers money going out to a named borrower, not a payoff coming back.
  Systemic classifier patterns confirmed this run and worth a `tune-news-rubric` pass on
  `src/lib/newsRubric.md` § "Deal status": (1) the pending-vs-completed miss named in run 2 recurs
  and now has a *Debt-specific* flavour — a DFI loan headline with "lines up"/"proposed" is being
  staged `completed`, so the new lender's-approval rule needs an explicit counter-example that
  approval must have *already happened*; (2) sod-turnings, hotel/store openings, route launches and
  project-progress updates staged `completed` en masse (roughly half this batch); (3) caribank.org
  **procurement notices** are being staged as deals — a source-shaped miss the rubric never
  anticipated; (4) an asset "goes on sale for US$15m" (an asking price) staged as `completed`.
