# News skills — scope (draft for refinement)

> Companion to `docs/news-llm-classifier-plan.md`. Scope for two **skills** (not subagents)
> that support the LLM news classifier. The classifier itself runs automatically on the feed
> cron with the API key — these skills are the **human-in-the-loop workshop** around it, invoked
> only when you sit down to improve or operate the system. Neither classifies live headlines.
>
> **Skill vs subagent, for reference:** a skill is a *recipe* injected into the current agent's
> context when you invoke it (`.claude/skills/<name>/SKILL.md`); it has no separate context
> window and no cold-start. That fits this work, which is bursty and front-loaded, not a big
> standing job. (The **data-curator** subagent is separate — kept as a subagent because its work
> is steady and self-contained.)

---

## How the two skills relate

- **`triage-review-inbox`** = the recurring **operations** loop — clear the `review` queue the
  classifier defers to a human.
- **`tune-news-rubric`** = the **improvement** loop — fix the classifier so the queue shrinks and
  quality rises.
- They feed each other: triage surfaces the cases that drive tuning; tuning reduces future triage
  volume. Over time the queue should get smaller and the public feed cleaner.

---

## Skill 1 — `tune-news-rubric`

**Purpose.** Refine *how* the classifier decides `publish | review | drop` and assigns a category,
by editing the rubric (the LLM system prompt) and/or the heuristic fallback, and locking each
change in with a regression fixture so past decisions can't silently regress.

**Invoke when:**
- You spot a misclassification on the live feed (junk published, or a real story dropped/hidden).
- You want to resolve one of the 6 open judgment calls, or shift editorial voice.
- You add a new feed/source, country, or language and want the rubric to cover its vocabulary.
- Periodic audit of recent decisions.

**Files it owns / touches:**
- **`src/lib/newsRubric.md`** — the rubric source, sent verbatim as the LLM system prompt.
  Editing it changes what ships on the next feed run; no code change needed.
- `src/lib/newsRelevance.mjs` — the heuristic **fallback**; keep its intent aligned with the rubric.
- **`src/lib/newsClassifier.fixtures.mjs`** — the regression fixtures: `{title, source, country}
  → expected {decision, category?, deal_status?, deal_type?}`. Not wired into `npm test` — a
  fixture only asserts correctly against a live, billed Haiku call, so `tune-news-rubric` dry-runs
  it manually (see Verify below), not as an automated CI assertion.
- `docs/news-llm-classifier-plan.md` — the architecture/integration doc; it points at
  `newsRubric.md` rather than embedding the prompt, so there's nothing to keep in sync here.
- Reference only: `data/feeds.json` (sources + languages), `NEWS_CATEGORY_GROUPS` / `NEWS_GROUPS`
  (the fixed category vocabulary).

**Workflow:**
1. **Gather real evidence.** Pull the specific headlines that motivated the change (from the feed,
   the review inbox, or a reported miss). Tune on real examples, never abstractions.
2. **Diagnose.** For each, state the *correct* decision + category and *why* (its economic or
   non-economic nature) — in the rubric's "judge meaning, not words" style.
3. **Edit the rubric minimally.** Change the smallest part of the prompt that fixes the case without
   breaking others. Prefer adding a worked polysemy example over a blanket keyword rule.
4. **Add fixtures.** Add each motivating headline (and near-neighbors, e.g. gold-medal vs gold-mine)
   with its expected decision, so a future edit can't regress it.
5. **Keep the fallback aligned.** If it's a policy shift (not just an LLM-nuance case), mirror the
   intent in `newsRelevance.mjs` so the no-key fallback doesn't contradict the LLM.
6. **Sync the doc.** Update the Rubric section of `docs/news-llm-classifier-plan.md` to match the
   shipped prompt.
7. **Verify.** Run the fixtures (offline node test); if a key is present, dry-run the classifier on
   the motivating headlines; confirm `npm run build` is clean.

**Guardrails / policy:**
- Precision over volume; when torn between `publish` and `drop`, route to `review` — never silently drop.
- Category vocabulary is fixed by `NEWS_CATEGORY_GROUPS`; never invent categories; derive `group` from it.
- Only headline + source + tags are ever sent to the model — never article bodies.
- Rubric and fallback must not drift — they should agree on the same intent.
- Cost: fixtures run offline (no API); only the optional dry-run hits the API, on a handful of headlines.

**Output:** a minimal rubric edit + new fixtures + aligned fallback + synced doc, all verified.

---

## Skill 2 — `triage-review-inbox`

**Purpose.** Process the `review` bucket — the borderline items the classifier deferred to a human —
into **approve (publish)** or **reject (drop)**, and route the hard cases back into rubric tuning.

**Invoke when:**
- Periodically (after a feed refresh, or weekly) to clear the review queue.
- Before a publication push, when you want the public feed current.

**Files it touches:**
- `data/news_unclassified.json` — the review inbox (editor-owned `category` + `approved` fields).
- Reference: `NEWS_CATEGORY_GROUPS` (valid categories), the rubric doc (apply the same policy a human would).
- Runs `npm run promote` (validate approvals) → build merges approved rows via `dataHub.ts`.

**Workflow:**
1. **Load the queue.** Read `news_unclassified.json`; list pending items (`approved !== true`) with the
   classifier's `reason` and suggested category.
2. **Apply the rubric per item.** Make the call the classifier deferred: approve (set a valid
   `category` + `approved: true`) or reject (leave unapproved). Same "judge meaning" policy as the rubric.
3. **Confirm before writing.** Approving **publishes to the live site**, so present the proposed
   approve/reject list for confirmation before writing — or auto-approve only high-confidence items and
   hold ambiguous ones for the user. Never silently auto-approve.
4. **Write + promote.** Update only editor-owned fields in `news_unclassified.json`; run `npm run promote`
   to validate (does not rewrite `news.json`); build to merge.
5. **Feed hard cases back.** Any genuinely ambiguous item, or one the classifier got wrong, → hand to
   `tune-news-rubric` (add a fixture + rubric tweak) so the queue shrinks over time.

**Guardrails:**
- Approving = an outward-facing publish → **confirm with the user** before writing approvals.
- Touch only editor-owned fields (`category`, `approved`); never rewrite machine fields or `news.json`.
- Valid categories only (`NEWS_CATEGORY_GROUPS`).

**Output:** a cleaned review queue, approvals promoted, hard cases routed to tuning.

---

## Open questions to refine (yours to decide)

- **Auto-approve threshold** in triage — approve `review` items above some confidence automatically, or
  always hold the whole queue for your eyes? (Affects how "hands-on" the skill is.)
- **Do these stay skills, or does one graduate to a subagent** once the volume is known? Start as skills;
  promote only if a queue genuinely gets large and recurring.

---

## Example invocation — `tune-news-rubric` (until this is a real `.claude/skills/` file)

Neither skill exists as an actual invokable `.claude/skills/<name>/SKILL.md` yet — this doc is
still the plan, followed by hand. Until it's built, this is the prompt shape to type when you
want the workflow above run against real evidence. It follows the same steps this doc already
specifies (gather evidence → diagnose → edit the rubric minimally → add fixtures → verify), so
copying this pattern gets you the same result whether or not a formal skill exists yet.

**Real example — this is the prompt that would have triggered the 2026-07-24 fix**, after a live
`npm run feeds` run surfaced two over-inclusion cases and one deal-detection over-trigger:

> Run `tune-news-rubric`. From today's live feed run, three headlines were misclassified:
> 1. "Transparency Institute wants IMO to investigate MV Barima tragedy" — got `publish/Government`,
>    should be `review` (bare accident-investigation call, no stated economic mechanism).
> 2. "Reyme slaat alarm over vervuiling Marowijnerivier" — got `publish/Climate`, should be `drop`
>    (pollution alarm with no stated economic impact).
> 3. "Sunrise Airways launches new Antigua-Barbados route" — got staged as a `completed/FDI` deal,
>    should be `not_a_deal` (operational route launch, not a capital transaction; the `publish`
>    news decision itself was already correct).
>
> Diagnose each against the rubric's own "judge meaning, not words" standard, make the smallest
> rubric edit that fixes all three without narrowing anything already correct (prefer a worked
> example over a blanket rule), add each as a fixture in `newsClassifier.fixtures.mjs`, then
> dry-run the fixtures against the live classifier to confirm the fix — including a sample of
> cases that must NOT regress — before treating it as done.

The general template for any future case: name the specific headline(s), what they got vs. what
they should have gotten, and why — then let the workflow's own steps (in this doc) drive the
rest. Don't hand-write the rubric edit yourself; describing the failure precisely is the
important part, since the model doing the tuning needs the same "judge meaning, not words"
evidence a human editor would.
