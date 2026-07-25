# Deals triage — finalized scope (subagent)

> **Filename kept for link stability** (`docs/deals-skill-scope.md` is referenced by memory
> `[[deals-investment-pipeline]]` and `docs/news-llm-classifier-plan.md`). Despite the name, the
> decision below is a **subagent, not a skill** — see the reversal note.
>
> Companion to `docs/news-llm-classifier-plan.md` § "Deals & Investment Page Routing". This is the
> design rationale; the **executable recipe** lives in `.claude/agents/triage-review-deals.md`
> (the same split as `docs/news-skills-scope.md` ↔ `.claude/agents/triage-review-inbox.md`).

---

## Decision reversal (2026-07-25, in session)

The 2026-07-24 draft of this doc scoped a **confirm-per-item skill**, mirroring what
`triage-review-inbox` was *planned* to be. Two things changed that:

1. **`triage-review-inbox` actually shipped as an autonomous subagent ("ian"),** not a
   confirm-per-item skill — it runs unattended, auto-commits and pushes to `main`, and its own
   file states it is "the deliberately more autonomous version" of the superseded skill plan. The
   worked example the deals doc was mirroring no longer exists in the form it mirrored.
2. **The operator's constraint:** once school resumes, hand-approving a queue row-by-row isn't
   sustainable. The goal is **asynchronous, low-frequency review of a digest** — not synchronous
   per-item approval. That is exactly the subagent shape: publish the clear cases, then hand back a
   report; a human skims it when convenient and reverts anything wrong; the genuinely-uncertain
   cases sit in an escalation queue and **never** auto-publish.

**So: a subagent (`triage-review-deals`), built on ian's pattern, with one deals-specific twist —
it drafts new structured facts (`parties`/`value`/`type`), where ian only makes a binary
publish/drop call on content that already exists.** That extra dimension is why the auto-publish
bar is stricter and more precisely defined than ian's (below).

This supersedes the "skill, not subagent" line in memory `[[deals-investment-pipeline]]` and in the
2026-07-24 header of this doc; both get updated when the build is approved.

---

## Why a subagent is safe here (the risk, and how the design contains it)

News triage is binary on **content that already exists** — worst case, a stray headline appears on
the feed. Deals are different: the agent **fills in blank fields** (`parties`, `value`), so it is
*generating structured facts*. The worst case is not "an irrelevant deal appears," it is **"a deal
appears with a wrong dollar figure or the wrong acquirer"** — a fabricated financial claim on a
site whose whole pitch is rigor. That is materially worse than a stray headline.

The containment is a single principle: **transcription, not inference.** The agent may only
auto-publish facts the source *explicitly states*, so filling a field is copying, not guessing.
"95% confident the deal is real" is not something an LLM can act on reliably; "the source
explicitly names the parties and states the figure" is checkable. When a field would require
inference or estimation, that is an automatic **escalate**, never an auto-publish.

---

## The three outcomes

Per pending row, exactly one of:

### Auto-publish — only if **all five** hold (the transcription-fidelity bar)

1. It is genuinely a **completed capital transaction** — the agent re-judges this itself; it does
   **not** defer to the classifier's `deal_status: "completed"` (the classifier over-stages — see
   the ownership-vs-operational gate).
2. **Parties are explicitly named** in the source — the principal actor(s). One named actor is
   sufficient for inherently single-sided types (FDI/Bond/IPO); M&A ideally names acquirer + target
   but **acquirer-alone is acceptable when the source only names one side** (see `parties`
   redefinition).
3. **Value is either an explicitly stated figure** (e.g. "US$620 million") **or explicitly reported
   as undisclosed** by the source. A value that is simply *absent* from the article — not stated as
   undisclosed — is not fillable by transcription → escalate. Never write an inferred/estimated
   number.
4. **`type` maps cleanly to one `DealType`** (`M&A | FDI | Bond | IPO | JV | Concession | Other`).
5. It is **not a near-duplicate** of a deal already published or already in this same review batch.

All five → fill `parties`/`value`/`type`, set `approved: true`, publish. Anything less → reject or
escalate below.

### Reject — mark reviewed in place (`triaged: true`, `approved: false`)

- **Not a capital transaction** (fails condition 1): operational spending, a service launch, a
  regulatory approval, a construction project. → the ownership-vs-operational gate.
- **A `pending`/proposed transaction** the classifier mis-staged as `completed` (e.g. a "proposed"
  bond, an MOU, a deal awaiting regulatory approval). The page shows *completed* deals; a pending
  one is a reject **and** a classifier miss → route to `tune-news-rubric` (§ "Deal status").
- **A superseded near-duplicate** — the non-canonical row of a same-story cluster.

Rejected rows are **marked reviewed in place**, not deleted — an audit trail of what was considered
and why, and so a re-staged headline doesn't re-litigate from scratch.

### Escalate — hold for human (`triaged: false`, `escalated: true`, `reviewNote`)

A **genuine deal** where a field can't be filled by transcription: ambiguous parties, a value
that's neither stated nor explicitly undisclosed, a real completed-vs-pending doubt, or a borderline
ownership-vs-operational call. Reserve this for genuine ties a human might reasonably want to
override — not a catch-all for "unsure." Escalated rows keep surfacing until a human resolves them.

---

## The gate: investment/ownership vs. operational spending

The qualifier is **not the size of the figure** — it is whether capital is changing hands *for
ownership or return*. This is the line that keeps a big operational number (WASA's "$20M wastewater
project") out while letting a big single-actor investment (Image Plus's "$620m acquisitions") in.

- **In** — ownership / equity / financing events: acquisition or stake purchase, FDI project
  commitment, bond/note issuance, IPO/rights issue, JV formation with capital, concession/licence
  award.
- **Out** — operational spending wearing a price tag: a utility launching a construction project, a
  ministry program budget, a service/route/store rollout, a planning-permission approval.

This is the same line `src/lib/newsRubric.md` § "Deal status" already tries to draw ("money or
equity changing hands… not routine operational activity"); the agent applies it as the **second,
stricter judge** over the classifier's demonstrably over-inclusive first pass.

## Page scope + `parties` redefinition

The page is **"Deals & Investment," and stays that way** — single-actor investment is in-scope by
design, not just clean two-party M&A. The `DealType` vocabulary already commits to this: FDI, Bond,
IPO are inherently one-sided (the already-live Petronas FDI row has no counterparty). Narrowing to
two-party M&A would shrink the page below what's already published.

Accordingly, **`parties` = the named principal actor(s) the source states**, not a forced
buyer/seller pair: two for a clean M&A, but legitimately one for an FDI, a bond issuer, or the
Image Plus case (Image Plus is deploying $620m on acquisitions; the targets aren't named in the
headline — `parties: "Image Plus"` states exactly what's known and fabricates nothing).

---

## Files & infrastructure

### Owned / touched by the agent

- `data/deals_inbox.json` — the staging queue. **Human-fillable / triage-writable fields:**
  `parties`, `value`, `type`, `approved`, plus status fields `triaged`, `escalated`, `reviewNote`
  (the last three are new, mirroring ian's inbox). **Machine-owned, never touched:** `id`,
  `headline`, `date`, `country`, `suggestedType`, `url`, `source`. (If `country` is clearly wrong,
  **escalate with a note** — don't hand-correct a machine field.)
- `.claude/agents/triage-review-deals.calibration.md` — persistent strictness memory; read before
  every run, appended after. Same contract as ian's calibration file.
- Reference only: `src/lib/types.ts` `DealType`; `src/components/deals/DealsFeed.astro` (the
  consumer); `src/lib/newsRubric.md` § "Deal status" (the shared standard).

### To be built (held for review — **not** written this pass)

1. **`scripts/triage-deals.mjs`** — the *only* write path into `data/deals_inbox.json`, mirroring
   `scripts/triage-inbox.mjs`. Two modes:
   - `--list` → prints pending rows (`triaged !== true && approved !== true`) as JSON to stdout.
   - `--apply <patch.json>` → applies a JSON array of decisions, **validates the whole resulting
     file, writes atomically (all-or-nothing).** Validation contract:
     - Only `parties`, `value`, `type`, `approved`, `triaged`, `escalated`, `reviewNote` may be set
       per entry (plus `id` to target the row). A patch touching any machine field is rejected.
     - If `approved: true` → `type` must be a valid `DealType`, `parties` non-empty, `value`
       non-empty (a stated figure or the literal `"Undisclosed"`). This is the guard that stops a
       half-drafted or bad-`type` row from ever reaching `deals.json`.
     - `approved`/`triaged` must be booleans; no duplicate `id`s within a patch.
   - Rationale for the script (weaker than for ian, but real): the agent runs **unattended**, so it
     needs atomic all-or-nothing writes and field-level validation the same way ian does — a human
     isn't watching each write. See the 2026-07-25 discussion: the write-safety justification that
     was *dropped* under the confirm-per-item skill assumption **returns** now that the tool is
     autonomous.
2. **`buildDeals()` guard** (`scripts/build-feeds.mjs`) — today it promotes any row with a *truthy*
   `type`; it does **not** check `type ∈ DealType` or that `country` is valid, and `dataHub.ts`
   casts `deals.json` with no runtime guard, so a bad value would render live and `npm run build`
   would **not** catch it. Add an enum/country check inside `buildDeals()` so **every** path into
   `deals.json` is guarded — including the launch fallback of hand-curating `deals.json` directly,
   which a skill-specific validator wouldn't protect.
3. **`.claude/agents/triage-review-deals.calibration.md`** — seed file (content drafted in the
   appendix below).
4. **Memory update** — `[[deals-investment-pipeline]]`: flip "skill, not subagent" → subagent, and
   record the transcription-fidelity bar + ownership-vs-operational gate as the operative rules.

### Unchanged, already exists

`stageDeals()` (classification → queue), `npm run promote` → `buildDeals()` (queue → `deals.json`,
non-destructive), `DealsFeed.astro` (render). The agent slots into the one gap — reviewing the queue
— and adds no new promotion code.

---

## Guardrails

- **Zero tolerance for false positives**, redefined for deals: a *published deal carrying a wrong or
  unverifiable figure or wrong parties* is the false positive to avoid at all costs. When torn →
  escalate, never auto-publish. This overrides every "be decisive" instruction.
- **Transcription, not inference** — never fabricate `value` or `parties` beyond what the source
  states; a field that can't be transcribed → escalate.
- **`type` ∈ `DealType`** only — never invent a category.
- **Visibility, not blind trust** — every auto-publish is a git commit the human can revert, and the
  agent's report lists, per published deal, the exact `value` + `parties` + `type` + source URL it
  drew them from, so an async skim catches a bad transcription in seconds.
- Touch only the triage-writable fields via `scripts/triage-deals.mjs --apply`; never hand-edit
  `data/deals_inbox.json` or `data/deals.json` directly.
- Dedupe same-story clusters **before** publishing, not after.
- Never touch `data/news.json`, `data/news_unclassified.json`, or `data/pub_inbox.json`.

---

## Worked examples (from the queue observed 2026-07-25 — patterns, not these exact rows)

- **"Image Plus to pay $620m for recent acquisitions"** (+ a near-identical Gleaner variant) — clean
  **auto-publish**: named actor (Image Plus), stated figure ($620m), type M&A; dedupe the two rows to
  one canonical entry. `parties: "Image Plus"` is honest even without named targets.
- **"Petronas eyes final investment decision… 1 billion barrels"** (already approved) — the shape of
  a legitimate **single-actor FDI**: one named investor, no counterparty, in-scope.
- **"New Canadian firm moves to acquire 64 km² of mineral claims in US$1.1M deal from local owner"**
  — **auto-publish** M&A after a WebFetch confirms the acquirer's name (both sides gestured at:
  Canadian firm ← local owner), stated figure US$1.1M.
- **"TotalTec, aHa form joint venture to tackle Guyana's skills gap"** — **escalate**: a JV *is* a
  deal type, but "to tackle skills gap" reads possibly-operational (a training partnership) rather
  than a capital JV; the ownership/financing nature isn't stated → hold, don't auto-publish.
- **"Government exempts proposed US$800m bond issue from taxes"** — **reject as pending**: "proposed"
  → not yet closed; page shows completed deals. Also a classifier miss (staged `completed`) → route
  to `tune-news-rubric`.
- **"WASA launches $20M wastewater project" / "MV Golden Carrier to join… at No Additional Cost" /
  "CPA approves 10-storey block"** — **reject** in this cluster: operational capex / an explicitly
  no-cost operational move / a planning approval — none is capital changing hands for ownership.
  Recurring pattern → recommend a `tune-news-rubric` pass on § "Deal status".

---

## Resolved decisions (this session)

- Subagent, not skill (autonomous, async-digest review). ✔
- WebFetch the source to draft `parties`/`value` under the transcription-fidelity bar. ✔
- Rejected rows **marked reviewed in place**, not deleted. ✔
- **Kept fully separate** from `triage-review-inbox` (ian) — the queues differ in kind (binary
  approve/reject vs. field-drafting) and schema; combining adds branching without a real win. ✔
- Page stays "Deals & Investment"; `parties` = named principal actor(s); gate = ownership vs.
  operational. ✔
- **Name = `warrenb`** (invocation name; file stays `triage-review-deals.md`). ✔
- **First-run caution is firm, not optional.** Until the calibration file records an explicit human
  authorization to auto-publish, auto-publish is disabled: would-be-publishes get their fields
  fully drafted but are escalated for a first-batch human confirmation; rejects proceed normally.
  Once the human confirms the first batch and records it, caution lifts. ✔

## Still open (flag on review)

- **Auto-publish volume cap per run?** ian has no cap; deals volume is low, so probably unnecessary.
  First-run caution already covers the "prove the bar before trusting it" concern, so a numeric cap
  is likely redundant — left unset unless a run proves otherwise.

---

## Appendix — calibration seed (`.claude/agents/triage-review-deals.calibration.md`, to be created)

```markdown
# triage-review-deals — calibration notes

Persistent record of how strict the `triage-review-deals` subagent's auto-publish / reject /
escalate bar should be. Read in full before every run; updated at the end of every run.

**How this file works:** the bar starts at maximum strictness and only loosens from a specific,
named, confirmed miss — never a general relaxation, and never anything that makes publishing a
deal with an unverified figure or wrong parties more likely. Zero tolerance for false positives
(a wrong/unverifiable published deal) always overrides everything recorded here.

---

- **<seed date>** — Seed entry. No adjustments yet, and **first-run caution is ACTIVE**:
  auto-publish is disabled until a human reviews a first batch and records authorization here. In
  the meantime, would-be-publishes are fully drafted (parties/value/type transcribed from the
  source) but escalated for confirmation, not published; operational spending and pending/proposed
  deals are rejected as normal. Running at maximum strictness: transcription, not inference.
```
