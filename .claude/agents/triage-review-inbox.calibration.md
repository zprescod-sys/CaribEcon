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
- **2026-07-25** — Run 2 (46 pending rows triaged: 2 approved, 43 rejected, 1 escalated).
  No adjustments this run — no human flagged a specific past decision as wrong, so the bar
  stays at maximum strictness. Notable in-run judgment calls, applied under the existing
  standard rather than any new lesson: (1) a ~22-row disaster/tragedy-commentary cluster
  (MV Barima aftermath — COI calls, salvage, trauma counselling, burial-fee waivers,
  governance op-eds — plus one unrelated St. Lucia boating-accident COI story and a
  Georgetown fire/dead-fish-in-canal pair) rejected in bulk as governance/human-interest
  commentary with no stated economic mechanism; (2) "Belize Diaspora Summit 3.0" escalated
  per the existing seed example — WebFetch of the source 403'd (bot-blocked), so the
  investment-vs-community-event ambiguity remains genuinely unresolved, not confirmed
  either way; (3) "BVI welcomes 102 new Belongers" and "ExxonMobil contract boat done gone
  ah falls" were WebFetched and rejected on content (routine residency-by-tenure/marriage
  ceremony with no investment mechanism; an opinion letter with no real contract/vessel
  detail, respectively) — not new lessons, just confirms sparse WebFetch use resolves
  ambiguity correctly; (4) "Gov't puts Silver Sands villas up for sale as Harmony Cove
  project stays dormant" approved as Investment — a stated, unambiguous government
  asset-sale action, the shape of a clean approve per the existing FPSO/Rystad example.
