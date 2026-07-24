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
- **The rubric source** — the LLM system prompt. *Design note:* keep it as a versioned text/markdown
  constant the classifier imports (e.g. `src/lib/newsRubric.md`) so tuning is a clean doc edit, not
  a code edit buried in `newsClassifierLLM.mjs`.
- `src/lib/newsRelevance.mjs` — the heuristic **fallback**; keep its intent aligned with the rubric.
- **Regression fixtures** — a `{title, source, tags} → expected {decision, category}` table
  (replaces the deleted `newsRelevance.test.mjs`; e.g. `src/lib/newsClassifier.fixtures.mjs`).
- `docs/news-llm-classifier-plan.md` — the canonical rubric doc; keep in sync with the shipped prompt.
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

- **Where the rubric physically lives** — a standalone `src/lib/newsRubric.md` the classifier imports
  (recommended, clean to tune) vs. an inline constant in `newsClassifierLLM.mjs`.
- **Auto-approve threshold** in triage — approve `review` items above some confidence automatically, or
  always hold the whole queue for your eyes? (Affects how "hands-on" the skill is.)
- **Do these stay skills, or does one graduate to a subagent** once the volume is known? Start as skills;
  promote only if a queue genuinely gets large and recurring.
- **Fixtures format** — revive `newsRelevance.test.mjs` as the fixtures home, or a new
  `newsClassifier.fixtures.mjs`? (Tie to `npm run test`.)
