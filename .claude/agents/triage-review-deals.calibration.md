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
