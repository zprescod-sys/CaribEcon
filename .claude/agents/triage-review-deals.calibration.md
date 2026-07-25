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
