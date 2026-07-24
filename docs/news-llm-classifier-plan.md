# LLM news classifier (Claude Haiku) at ingest — key never exposed

> **Canonical, consolidated plan.** This supersedes the earlier plan-mode copy in
> `~/.claude/plans/`. The editorial rubric itself now lives in `src/lib/newsRubric.md` (see the
> pointer at the bottom of this doc) — this file is the architecture / integration plan.

## ⚠️ Correction — heuristic-fallback API changed (post-revert)

The original plan kept the branch's `assessNews(title, tags)` (publish/review/drop) rewrite as
the deterministic fallback and sequenced this work "after the rewrite lands on main." We have
since decided to **revert the news-classification rewrite back to main** — that direction
(regex evidence-roles) is abandoned in favour of this LLM classifier.

On `main` there is **no `assessNews`**. The heuristic that remains (and becomes the fallback)
exports:

- `isRelevantNews`, `classifyNews`, `isDisplayableNews`, `getNewsReviewDecision`
- `CONFIDENCE_RANK = { low, medium, high }`, `MIN_NEWS_CONFIDENCE = 'medium'`
- `NEWS_CATEGORY_GROUPS`, `NEWS_GROUPS`

Implications for everything below:

- The **LLM** is the *only* place the `publish | review | drop` decision shape lives.
- The **heuristic fallback** produces main's shape — an `isDisplayableNews(title, tags)` boolean
  plus a `getNewsReviewDecision(...)` candidate — which must be **mapped** onto
  `publish | review | drop` (displayable → `publish`; review-candidate → `review`; else `drop`).
- Wherever the plan text says `assessNews`, read it as "main's
  `isDisplayableNews` / `classifyNews` / `getNewsReviewDecision`."

---

## Context

News relevance + categorization on `main` is a hand-tuned regex heuristic in
`src/lib/newsRelevance.mjs` — `isDisplayableNews` / `classifyNews` / `getNewsReviewDecision`
on a `low|medium|high` confidence model — applied at **both** ingest
(`scripts/build-feeds.mjs`) and render (`src/lib/dataHub.ts`). It is precise but brittle on
edge cases: it cannot read context, so the same word (gold, market, currency, takeover) is a
false positive in one headline and a real story in the next.

Goal: make a **Claude Haiku 4.5** call the *primary* classifier, producing a
`publish | review | drop` decision + category, with the existing heuristic kept as a
**deterministic fallback** (no key / API down / local build). Crucially, this must never expose
an API key on the static site — and it doesn't have to, because classification runs
**server-side at ingest inside the existing news GitHub Action**, exactly like the current cron.
The browser only ever receives the classification *result*.

**Decisions (confirmed with user):** model `claude-haiku-4-5`; **LLM-primary + heuristic
fallback**; regex-rewrite direction abandoned and reverted to main; LLM also replaces the
regex-based deal detector for the Deals & Investment page (see the dedicated section below).

## Architecture — where it runs, and why the key is safe

- The site is **static Astro output on Vercel**. Classification happens at **ingest** in
  `.github/workflows/feeds.yml` (Node, on GitHub's runner) — not in the browser.
- `src/lib/dataHub.ts` runs at Vercel **build** but **never calls the API** — it reads the
  verdict already stored in `news.json`. So the key only ever exists on the GitHub runner.
- The key lives **only** as a GitHub Actions secret and reaches the shipped site as *zero
  bytes* — `news.json` carries `{category, group, decision}`, never the key.

## Plan

### 1. New module — `src/lib/newsClassifierLLM.mjs`

- `export async function classifyHeadlinesLLM(items, { model })` → per-item
  `{ id, decision, category, group, confidence, reason, deal_status, deal_type }`, decision in
  `publish | review | drop`.
- Uses **`@anthropic-ai/sdk`** (`new Anthropic()` — reads `process.env.ANTHROPIC_API_KEY`
  automatically). One **batched** `messages.create` per chunk, with a **structured-output JSON
  schema** (`output_config.format`) returning an array of per-item result objects. `group` is
  derived locally from `NEWS_CATEGORY_GROUPS` inside this module — the model is never trusted
  for that mapping.
- System prompt = the rubric in **`src/lib/newsRubric.md`** (read once at module load via
  `fs.readFileSync`, resolved from `import.meta.url` — ESM has no `__dirname`). Import
  `NEWS_CATEGORY_GROUPS` / `NEWS_GROUPS` from `newsRelevance.mjs` as the single source of the
  category vocabulary so the LLM's categories and the heuristic fallback can't drift — the
  structured-output schema's `category` enum is built from `Object.keys(NEWS_CATEGORY_GROUPS)`
  at runtime, so the model is *mechanically* prevented from emitting a category outside that set
  (stronger than a prose instruction).
- Model `claude-haiku-4-5`. **No `thinking`, no `output_config.effort`** — `effort` is not a
  supported parameter on Haiku 4.5 and returns a 400 if set; simple classification doesn't need
  extended thinking either. `max_tokens` sized to the batch (kept comfortably under ~16K per
  call — see chunking below — so no request ever needs to stream). **Only headline + source +
  tags + country** are sent — never article bodies (unchanged body-free policy). SDK
  auto-retries 429/5xx; on total failure it throws so the caller falls back.
- Large batches are split into chunks of 100 items per API call (sequential, not parallel) so a
  backlog catch-up run never produces a single oversized request. Typical daily volume (~50–100
  new items across two runs) is one chunk.

### 2. Integrate into `scripts/build-feeds.mjs`

- The pipeline already computes **new items this run** (ids not in the existing `news.json`).
- If `process.env.ANTHROPIC_API_KEY` is set → `classifyHeadlinesLLM(newItems)`, persist
  `{category, group, decision, confidence, reason, classifier: 'llm'}` onto each new record;
  publish/review/drop routing uses the LLM decision. Any item with `deal_status: 'completed'`
  also gets staged into `data/deals_inbox.json` (see the Deals & Investment section below) —
  `isDeal()` / `inferDealType()` are removed once this lands.
- If no key **or** the call fails → fall back to the heuristic for those items, tagged
  `classifier: 'heuristic'`: map `isDisplayableNews`/`getNewsReviewDecision` →
  `publish | review | drop` (see the Correction note above). No key means no `deal_status`
  either — nothing is auto-staged to the deals queue that day; a human can still add a deal by
  hand as always.
- Classify **only new items**; existing records keep their stored verdict → cost stays
  near-zero and re-runs with no new items make **zero** API calls. Review-inbox staging is
  otherwise unchanged (it consumes the decision).

### 3. Render — `src/lib/dataHub.ts`

- When a record carries a stored verdict, gate on `record.decision === 'publish'` instead
  of re-running `isDisplayableNews`; fall back to `isDisplayableNews(title, tags)` for
  legacy records with no stored verdict. `classifyNews` stays for chips on records lacking a
  stored category.

### 4. Dependency + config

- `npm i @anthropic-ai/sdk` (add to `package.json` dependencies). **Done.**
- Add a committed **`.env.example`** with `ANTHROPIC_API_KEY=` (empty placeholder, docs only). **Done.**
- Env knobs: `NEWS_LLM=0` to disable (checked in `build-feeds.mjs`), `NEWS_LLM_MODEL` (default
  `claude-haiku-4-5`, read inside `newsClassifierLLM.mjs` itself so the caller doesn't have to
  thread it through).

### 5. Workflow — `.github/workflows/feeds.yml`

- Add to the **"Fetch & merge feeds"** step only:
  `env:` → `ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}`.
- Nothing else changes; commit-if-changed already covers `news.json` and `data/deals_inbox.json`
  (already listed in the commit step today).

## API key — how it is never exposed (the detailed part)

1. **Provider & key.** Anthropic Claude API. Create a **dedicated** key in the Anthropic
   Console (API keys), scoped to a workspace — not a personal all-access key. **Done.**
2. **Storage — one place only.** GitHub repo → **Settings → Secrets and variables →
   Actions → New repository secret** → name `ANTHROPIC_API_KEY`. It's referenced solely as
   `${{ secrets.ANTHROPIC_API_KEY }}` in `feeds.yml` and surfaces to Node as
   `process.env.ANTHROPIC_API_KEY`. GitHub encrypts it at rest and injects it only into that
   job. **Done.**
3. **Browser never sees it (static-site guarantee).** Classification runs in the Action;
   `dataHub.ts` never calls the API. The key is read via `process.env` inside a module that
   is **not** imported by any client bundle, so it never lands in a browser-shipped file.
   **Never prefix it `PUBLIC_`** — Astro/Vite inline `PUBLIC_`-prefixed vars into the client
   bundle; the un-prefixed `ANTHROPIC_API_KEY` stays server-only. Verify after a build:
   `grep -rn "sk-ant" dist/` and a grep for the literal key value must return nothing.
4. **Never committed.** `.gitignore` already ignores `.env` / `.env.*` (keeps
   `!.env.example`). Local dev: put the key in a gitignored `.env` and run
   `node --env-file=.env scripts/build-feeds.mjs` (Node 20+). Never hardcode the key in any
   `.mjs`/`.ts`/`.astro` — construct `new Anthropic()` with no args and let the SDK read env.
   **Done.**
5. **CI log hygiene.** GitHub auto-masks registered secrets in logs (any echo prints `***`).
   Don't `console.log` the key; don't pass it as a CLI arg (visible in `ps`) — env only.
6. **Spend + blast radius.** Set a spend limit on the key's workspace in the Console so a bug
   can't run up cost; scope the key minimally; **rotate** immediately on any leak (Console →
   roll key, then update the single GitHub secret). **Done** (weekly cap set in Console).
7. **Accidental-leak defense.** GitHub's automatic secret scanning + push protection requires a
   public repo (or paid GitHub Advanced Security) — not available on this private personal
   repo, and **not worth flipping visibility for**. The real defenses (`.gitignore`, never
   hardcoding, key only in the GitHub Actions secret) don't need it. A local `gitleaks`
   pre-commit hook remains an easy optional add-on later if wanted.
8. **Vercel note.** Because classification is in GitHub Actions (not a Vercel Function or
   Vercel build step), the key does **not** go in Vercel at all — removing an entire exposure
   surface. If classification ever moves into a Vercel Function, store it as a **Server**
   Environment Variable (never `PUBLIC_`/`NEXT_PUBLIC_`) and `vercel env pull` for local; this
   plan stays GitHub-only.

## Critical files

| Action | File                                                                                                                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| New    | `src/lib/newsClassifierLLM.mjs` (batched Haiku call → decision objects)                                                                         |
| New    | `src/lib/newsRubric.md` (the editorial policy — the shipped system prompt, single source of truth)                                             |
| New    | `.env.example` (empty `ANTHROPIC_API_KEY=` placeholder)                                                                                        |
| Edit   | `scripts/build-feeds.mjs` (LLM-classify new items, persist verdict, heuristic fallback, stage completed deals, remove `isDeal`/`inferDealType`) |
| Edit   | `src/lib/dataHub.ts` (trust stored verdict; `isDisplayableNews` fallback)                                                                      |
| Edit   | `.github/workflows/feeds.yml` (add `ANTHROPIC_API_KEY` secret env to the feeds step)                                                           |
| Edit   | `package.json` (add `@anthropic-ai/sdk`)                                                                                                       |
| Edit   | `src/lib/newsRelevance.mjs` (`NEWS_CATEGORY_GROUPS` gains 5 categories the rubric already used: Agriculture, Climate, Government, Technology, Regional Developments) |
| Reuse  | `isDisplayableNews` / `classifyNews` / `getNewsReviewDecision` / `NEWS_CATEGORY_GROUPS` / `NEWS_GROUPS` in `src/lib/newsRelevance.mjs` |

## Verification (end-to-end)

1. **No key (fallback path):** `npm run feeds` → runs, new items tagged
   `classifier: 'heuristic'`, `npm run build` clean. Proves the site never needs a key.
2. **With key:** `node --env-file=.env scripts/build-feeds.mjs` on a small sample → new
   items carry `classifier: 'llm'` + category/decision; spot-check classifications vs. the
   heuristic on the known-tricky headlines (gold-medal vs gold-mine, "attention is currency",
   Crop Over, Talent Takeover, a Dutch Starnieuws headline).
3. **Key-leak checks:** `npm run build` then `grep -rn "sk-ant" dist/ && echo LEAK || echo clean`;
   grep the literal key value in `dist/` and via `git grep` → nothing.
4. **Cost check:** re-run with no new items → zero API calls (only new ids are classified).
   Budget reference: ~100 new headlines/day, twice-daily batched calls ≈ **$1.50–4/month** on
   Haiku 4.5 (system-prompt overhead per run is the main fixed cost, not headline count).
5. **Action:** add the GitHub secret, trigger `feeds.yml` via **workflow_dispatch** →
   confirm it classifies, the run log masks the secret (`***`), and the daily commit lands.

## Sequencing note

Land the **revert of the news files to main first** (removes the abandoned regex rewrite), then
build this LLM layer on top of main's settled heuristic. The heuristic stays load-bearing as the
fallback — the LLM wraps it, it does not replace the file.

---

## Deals & Investment Page Routing — LLM replaces the regex detector

**Decision (confirmed with user, 2026-07-23):** `data/deals_inbox.json` already exists and is
already live — populated today by a regex-based deal detector in `scripts/build-feeds.mjs`
(`isDeal()` / `inferDealType()`, ~line 68–113). The LLM classifier **replaces** that detector; it
does not run alongside it and does not create a second, differently-shaped queue file. One
detection path, using the schema the Deals page already reads. The editorial judgment for this
(what counts as `completed` vs `pending`, the `deal_type` vocabulary) lives in
`src/lib/newsRubric.md` → "Deal status" — this section is integration only: what the code does
with that judgment.

`deal_status` and `deal_type` are evaluated on every item as part of the same classification call
(no separate pass, no separate API call) — but only `deal_status: "completed"` items are staged
into the deals queue.

### Queue file — reuse `data/deals_inbox.json`, existing schema, no new file

When `deal_status: "completed"`, append an entry to `data/deals_inbox.json` in its **existing**
shape (`src/lib/types.ts` `DealType`, `src/components/deals/DealsFeed.astro` consumer):

```json
{
  "id": "deal-<shortHash(url)>",
  "headline": "<article title>",
  "parties": "",
  "value": "",
  "date": "<ISO date>",
  "country": "<country code, or best guess>",
  "type": "",
  "suggestedType": "<the LLM's deal_type>",
  "url": "<article url>",
  "source": "<source name>",
  "approved": false
}
```

Same fields the existing detector already leaves blank for a human to fill in (`parties`,
`value`, `type`) stay blank here too — the LLM does not fabricate deal terms it can't verify from
a headline. `suggestedType` is the one upgrade: it comes directly from the LLM's `deal_type`
output (rubric-constrained to the same `DealType` vocabulary as `src/lib/types.ts`), replacing
`inferDealType()`'s keyword guess. Dedupe by `id` (same `deal-<shortHash(url)>` scheme as today)
so a re-run never double-appends. `approved` always starts `false` — a human still promotes to
`data/deals.json` exactly as today, via the existing review step.

### Removed

`isDeal()`, `DEAL_VERB_RE`, `MONEY_RE`, `DEAL_PHRASES`, `SHARE_SIGNAL_RE`, `inferDealType()` in
`scripts/build-feeds.mjs` are deleted once the LLM path lands — kept only as the description of
what the LLM must judgmentally replace, not as a fallback (the heuristic fallback path for deals
is: no key → no `deal_status` is set → nothing is staged to the deals queue that day; a human can
still add a deal by hand as always).

---

## Rubric v1 — LLM system prompt

**Lives in `src/lib/newsRubric.md`, not here.** That file is read directly by
`newsClassifierLLM.mjs` at runtime and is the single source of truth for the shipped prompt —
editing it changes what ships on the next feed run, no code change and no doc-sync step needed.
This doc used to embed the full rubric text inline; that created a drift risk (the doc and the
shipped prompt could silently diverge) with no benefit, so it was extracted. Tune the rubric by
editing `src/lib/newsRubric.md` directly (see `docs/news-skills-scope.md` → `tune-news-rubric`
for the workflow); this doc stays the architecture/integration reference.

The rubric file covers: Role, the `publish|review|drop` decision + guiding bias, what is/isn't
economically relevant, the polysemy test (judge meaning not words), routing to review,
geographic + multilingual handling, the fixed category vocabulary, deal status (`completed |
pending | not_a_deal` + `deal_type`), the exact output JSON shape, and worked examples that
double as regression fixtures.
