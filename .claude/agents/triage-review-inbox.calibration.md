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
- **2026-08-04** — Run 3 (257 pending rows; 256 decided — 14 approved, 242 rejected — plus
  the pre-existing "Belize Diaspora Summit 3.0" escalation left untouched per the
  reviewNote-first rule, since its prior WebFetch attempt already 403'd with no new angle
  this session). No adjustments this run — no human flagged a specific past decision as
  wrong, so the bar stays at maximum strictness. Notable in-run judgment calls, applied
  under the existing standard rather than any new lesson: (1) a much larger MV Barima
  cluster this run (~90 rows spanning COI appointments/ToRs, murder charges, salvage
  debates, HEART Initiative donations, protests, and Dutch/English commentary from every
  angle) rejected in bulk on the same governance/human-interest-with-no-stated-mechanism
  basis as Run 2 — the pattern is stable and durable, not a one-off. (2) Ten WebFetches
  resolved genuine ambiguity in both directions, confirming sparse fetch use works: toward
  **approve** — a Kaieteur News letter on the IMF Article IV report (cited specific
  non-oil-deficit/external-debt figures, not just a vague headline), a Jamaica ganja-import
  policy piece (named CLA officials, retailer counts, a real reciprocity-trade argument), a
  St. Vincent road-cleaning programme (EC$3.29m budget, 6,600 workers — a real fiscal/labor
  figure the headline's "controversy" framing obscured), a Trinidad Express piece on
  businesses fearing political-donation-disclosure fallout (a specific $50,000 statutory
  limit and pending amendment bill — same shape as the existing "campaign finance reform"
  rubric example), and two Antigua Banking-Amendment-Bill-2026 stories (real bill, real
  senator, real financial-regulation mechanism, even without a headline dollar figure);
  toward **reject** — a "Destiny Project" pair (Nevis Special Sustainability Zone
  application under Federal review, but zero investment figures or project details
  disclosed), an MV Golden Carrier port-incident dispute (turned out to be a pure
  reporting-accuracy spat with no cargo/financial impact), and a WestJet-strike headline
  that read Labor-relevant but whose fetched article confirmed zero stated Caribbean-route
  nexus (Canadian-domestic strike coverage only) — a useful reminder that a plausible-
  sounding Labor/strike headline still needs a confirmed regional link, not just topical
  fit. (3) Two same-story duplicates (a US$32m COVID-relief-fraud extradition, reported by
  both Jamaica Gleaner and St. Kitts-Nevis Observer with the same figure) approved
  identically as Fiscal Policy — the queue's "recognize clusters" guidance applies to
  approvals, not just bulk rejects.
