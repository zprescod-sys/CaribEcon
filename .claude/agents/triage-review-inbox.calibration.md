# triage-review-inbox — calibration notes

Persistent record of how strict the `triage-review-inbox` subagent's approve/reject/
escalate bar should be. Read in full by the agent before every run; updated by the agent
(or a human) at the end of every run.

**How this file works:** the bar starts at maximum strictness and only loosens from a
specific, named, confirmed miss — never a general relaxation, and never anything that
would make approving an irrelevant story more likely. Zero tolerance for false positives
always overrides everything recorded here. Each entry below should name the exact pattern
being adjusted, not a vague "be more lenient."

---

- **2026-07-25** — Seed entry. No adjustments yet. Running at maximum strictness: approve
  only unambiguous, sourced economic substance; reject the clear majority outright; escalate
  only genuine ties a human might reasonably want to override.
