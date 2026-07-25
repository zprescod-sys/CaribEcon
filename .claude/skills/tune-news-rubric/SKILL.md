---
name: tune-news-rubric
description: Fix a misclassified CaribEcon news headline — wrongly published, wrongly dropped, or wrongly categorized — by editing the LLM classifier's rubric (src/lib/newsRubric.md) and/or the regex heuristic fallback (src/lib/newsRelevance.mjs), then locking the fix in with a regression fixture so it can't silently regress. Use when a live headline was misclassified, when adding a new feed/source/country/language the rubric doesn't yet cover, or when doing a periodic audit of recent classifier decisions.
---

# tune-news-rubric

The improvement loop for CaribEcon's news classifier. `triage-review-inbox` is the
operations loop that clears the review queue day to day; this skill is what actually
fixes the classifier so that queue shrinks and the public feed gets cleaner over time.
Full architecture: `docs/news-llm-classifier-plan.md`. Full skills context (how this
relates to `triage-review-inbox`): `docs/news-skills-scope.md`.

## What you're editing

Two systems have to agree, because either one can be the live decision-maker for a
given item (LLM when `ANTHROPIC_API_KEY` is set and the call succeeds; heuristic as the
deterministic fallback otherwise — see `NEWS_LLM_ENABLED` in `scripts/build-feeds.mjs`):

| System | File | What it is |
|---|---|---|
| LLM rubric | `src/lib/newsRubric.md` | The exact system prompt sent to Claude Haiku 4.5. Editing it changes what ships on the **next feed run** — no code change, no redeploy. |
| Heuristic fallback | `src/lib/newsRelevance.mjs` | `INCLUDE_RE`/`EXCLUDE_RE`/`RULES` — regex-based, used when there's no key, the API call fails, or for legacy records classified before this field existed. |
| Regression fixtures | `src/lib/newsClassifier.fixtures.mjs` | `{title, source, country} → expected {decision, category?, deal_status?, deal_type?}`. **Not run in `npm test`** — asserting them requires a live, billed Haiku call. Dry-run them yourself (see Verify). |
| Category vocabulary | `NEWS_CATEGORY_GROUPS` in `src/lib/newsRelevance.mjs` | The fixed category → group map. Both systems share it — the LLM's structured-output schema builds its `enum` directly from these keys, so it's mechanically impossible for the model to return a category the app doesn't understand. **Never hand-add a category anywhere else** — add it here first if it's genuinely new. |

## Invoke when

- A live headline was wrongly published, wrongly dropped, or given the wrong category —
  reported by the user, spotted on `/news`, or surfaced by `triage-review-inbox`.
- A new feed/source/country/language is added and its vocabulary isn't covered yet.
- You want to resolve one of the rubric's open judgment calls, or shift editorial voice.
- Periodic audit of recent classifier decisions (`classifier: 'llm'` records with
  surprising `category`/`decision`, or a cluster of heuristic-fallback records that
  should now be LLM-classified).

## Workflow

1. **Gather real evidence.** Get the exact headline(s) — title, source, country, tags,
   and (if relevant) `data/news.json`'s stored `category`/`decision`/`classifier` for
   that record. Tune on real examples, never abstractions. If the report is vague
   ("news page looks off"), find the specific offending record first — don't guess.

2. **Diagnose against the rubric's own standard.** For each headline, state the
   *correct* decision + category and *why*, in the rubric's "judge meaning, not words"
   style — name the specific economic mechanism, or the specific reason it's not one.
   If it's a heuristic miss, identify the exact regex responsible (which `INCLUDE_RE`
   or category `RULES` entry matched, and why the surrounding context defeats it — e.g.
   a word matched literally but meant something else, or a generic exclude category
   was under-specified).

3. **Edit the smallest thing that fixes it without narrowing anything already correct.**
   - **Rubric case** (an LLM judgment call): add a worked polysemy example to the
     rubric's table rather than writing a blanket rule — that's the whole design
     principle behind "judge meaning, not words." A blanket keyword rule just
     reintroduces the class of bug this classifier exists to avoid.
   - **Heuristic case** (a regex gap or false match): fix the regex directly, but check
     it against the *existing* include/exclude lists for redundancy or contradiction
     first — these lists tend to already enumerate specific terms in a category (e.g.
     every named sport is its own `EXCLUDE_RE` entry); a missing generic catch-all is a
     more likely root cause than a wrong specific term.
   - **New category needed**: add it to `NEWS_CATEGORY_GROUPS` first (both files derive
     from it), then reference it in the rubric and/or heuristic rules.

4. **Add fixtures.** Add the motivating headline(s) to `newsClassifier.fixtures.mjs`,
   *and* near-neighbor cases that must NOT regress (e.g. if fixing "gold" as a sports
   idiom, also add a real gold-mining headline that must still `publish`). A fixture
   with no negative-control neighbor doesn't prove the fix is precise, only that it
   isn't obviously wrong.

5. **Keep the fallback aligned with the rubric's *intent***, not necessarily identical
   wording — if this is a policy shift (not just an LLM-nuance case the heuristic was
   never expected to catch), mirror it in `newsRelevance.mjs` so the no-key fallback
   doesn't contradict the LLM's judgment on the same class of headline.

6. **Sync `docs/news-llm-classifier-plan.md`'s Rubric section** if the shipped prompt's
   substance changed (not needed for a pure fixtures-only or heuristic-only fix) — that
   doc should always describe what's actually shipped, never drift from it.

7. **Verify, in order:**
   - Fixtures load and are well-formed (offline, free):
     ```
     node -e "import('./src/lib/newsClassifier.fixtures.mjs').then(m => console.log(m.NEWS_CLASSIFIER_FIXTURES.length, 'fixtures'))"
     ```
   - If `ANTHROPIC_API_KEY` is available, dry-run every fixture against the live
     classifier — including a sample of cases that must NOT regress, not just the new
     ones — and diff against `expected`:
     ```
     node -e "
     import('./src/lib/newsClassifierLLM.mjs').then(async ({classifyHeadlinesLLM}) => {
       const { NEWS_CLASSIFIER_FIXTURES } = await import('./src/lib/newsClassifier.fixtures.mjs');
       const items = NEWS_CLASSIFIER_FIXTURES.map((f, i) => ({ id: String(i), title: f.title, source: f.source, country: f.country }));
       const results = await classifyHeadlinesLLM(items);
       let pass = 0, fail = 0;
       results.forEach((r, i) => {
         const exp = NEWS_CLASSIFIER_FIXTURES[i].expected;
         const ok = Object.entries(exp).every(([k, v]) => r[k] === v);
         ok ? pass++ : (fail++, console.log('FAIL', JSON.stringify(NEWS_CLASSIFIER_FIXTURES[i].title), 'expected', exp, 'got', { decision: r.decision, category: r.category, deal_status: r.deal_status, deal_type: r.deal_type }));
       });
       console.log(pass, 'pass,', fail, 'fail');
     });
     "
     ```
   - `npm test` (the offline heuristic unit tests) if `newsRelevance.mjs` changed.
   - `npm run build` clean.
   - If a live record is currently wrong on the site (not just future runs), decide with
     the user whether to hand-patch that one `data/news.json` record now — the rubric/
     heuristic fix only prevents *future* recurrences; it does not retroactively
     reclassify already-stored records (`decision` is written once and never
     recomputed — see `scripts/build-feeds.mjs`).

## Guardrails

- **Precision over volume — but never silently drop.** When genuinely torn between
  `publish` and `drop`, the correct target is `review`, not a coin flip either direction.
- **Category vocabulary is closed.** Never invent a category inline in a rule or a
  fixture; it must exist in `NEWS_CATEGORY_GROUPS` first.
- **Only headline + source + tags are ever sent to the model** — never article bodies.
  Don't change this to "help" diagnosis; fetch the source article yourself if you need
  more context, but the shipped prompt never gains that input.
- **Rubric and fallback must not contradict each other's intent** on the same class of
  headline, even though their literal wording can differ.
- **Cost discipline:** fixtures run offline by default (free); only the optional
  dry-run step hits the API, and only on the fixture set (currently a few dozen
  headlines) — not on live production traffic.
- **This skill never touches `data/news.json`, `data/news_unclassified.json`, or
  `data/deals_inbox.json` directly** — those are `triage-review-inbox` /
  `triage-review-deals` territory (or the feed cron's). If a fix requires hand-patching
  a currently-wrong live record, do it as an explicit, separate, called-out step — never
  bundle a silent data edit into a rubric-tuning commit.

## Output

A minimal rubric and/or heuristic edit, new fixtures (including negative controls),
an aligned fallback, a synced plan doc where relevant, and a verified dry-run — all
before calling the fix done.

## Worked example (the pattern to follow)

**2026-07-23** — a live `npm run feeds` run surfaced three misclassifications:

1. *"Transparency Institute wants IMO to investigate MV Barima tragedy"* — got
   `publish/Government`, should be `review` (bare accident-investigation call, no
   stated economic mechanism).
2. *"Reyme slaat alarm over vervuiling Marowijnerivier"* — got `publish/Climate`,
   should be `drop` (pollution alarm with no stated economic impact).
3. *"Sunrise Airways launches new Antigua-Barbados route"* — staged as a
   `completed/FDI` deal, should be `not_a_deal` (operational route launch, not a
   capital transaction — the `publish` news decision itself was already correct).

Each was diagnosed against the rubric's own standard, fixed with the smallest edit
that didn't narrow anything already correct (a worked example added to the rubric's
polysemy table, not a blanket rule), locked in as a fixture, and dry-run against the
live classifier — including a sample of cases that had to keep passing — before being
called done. That dry-run confirmed 12/12, no regressions.

**A second, still-open real case** (found 2026-07-24, live on the site): *"Slingerz FC
cruise into CFU Club Shield Round of 16 with commanding win over SWA Sharks"* — a
football headline, published as `Tourism`. Root cause: `cruise\w*` is both a strong
include-term and the `Tourism` category regex in `newsRelevance.mjs`; nothing in
`EXCLUDE_RE` catches generic "sports" (every specific sub-discipline is enumerated —
football, cricket, netball, etc. — but the bare word "sports" itself isn't, and this
headline uses none of the enumerated terms). This is a heuristic-only case — the record
predates this skill's classifier reaching that item — so the fix is in
`newsRelevance.mjs`'s `EXCLUDE_RE`, not the rubric, plus a decision on whether to
hand-patch the one already-published record per the Verify step above.
