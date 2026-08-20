/* executeResearchPlan() — the deterministic executor (docs plan §2d/§2h; ARCHITECTURE.md §3.2).
 *
 * Runs a VALIDATED ResearchPlan's steps with maximum safe CONCURRENCY (runStepsConcurrently,
 * below), not one at a time — dispatching each to the existing deterministic tools
 * (getSeriesEvidence/getSelectedCountrySeries/searchNews, all from askTools.ts) or the Tavily-
 * backed facade (searchWeb/extractWeb, webEvidence.ts), accumulating into the same
 * EvidencePackage shape buildEvidencePackage() already produces. Only extract_web has a real data
 * dependency (see point 2 below); every other step type — including two separate search_news
 * steps' own concurrent news-digest sub-batches — now runs together rather than queued behind
 * each other, which is most of where this function's wall-clock latency used to go.
 *
 * The caller (research.ts, wired in a later stage) is expected to call validateResearchPlan()
 * BEFORE this function — every country/indicator/onStep name here is assumed already resolved.
 * This file does not re-validate names. It DOES independently re-enforce the two things that are
 * a runtime-budget/safety concern rather than a validation concern:
 *
 *   1. Tavily call budgets (MAX_TAVILY_SEARCHES, MAX_TAVILY_EXTRACTS) — validateResearchPlan only
 *      caps total plan steps (MAX_PLAN_STEPS), not how many of them are Tavily-backed. Budget
 *      consumption order is unaffected by running steps concurrently — see runStepsConcurrently's
 *      own comment for why the check-then-spend pairs still resolve in exact plan order.
 *   2. extract_web authorization — THE CENTRAL SAFETY RULE. validateResearchPlan already checks
 *      that an extract_web step's onStep names a real, earlier search_web step in the STATIC plan
 *      (structural/cascading check, done once, before execution). This executor does NOT trust
 *      that check transitively. It re-derives authorization from its OWN runtime state: a
 *      `Map<stepId, WebEvidence[]>` populated ONLY as a search_web step is actually dispatched and
 *      actually returns results, in THIS execution run. An extract_web step may only extract URLs
 *      that are already sitting in that map under its own onStep id — and runStepsConcurrently
 *      makes it genuinely WAIT for that step to finish first, never just check-and-hope. If onStep
 *      is not a key in the map once that wait resolves — because the referenced step never ran
 *      (bad plan, static check bypassed or a hand-crafted plan handed to this function directly),
 *      was skipped for budget reasons, or returned zero results — extractWeb() is never called at
 *      all; a RetrievalMiss is recorded instead. This means a plan object assembled by hand
 *      (skipping validateResearchPlan entirely, as a test does) genuinely cannot trigger an
 *      unauthorized Tavily Extract call: there is no code path from "extract_web step present" to
 *      "extractWeb() invoked" that does not pass through a real, already-populated map entry keyed
 *      by that exact onStep id.
 *
 * News-digest side path (§2h, NOT Tavily): immediately after a search_news step returns results,
 * the top MAX_NEWS_DIGESTS of THIS step's own results (that carry a real http(s) url) are fetched
 * and enriched CONCURRENTLY (Promise.all) via fetchArticleText() (newsArticleFetch.ts, a plain
 * fetch — never Tavily) and extractArticleInsights() (the 'newsExtract' role, fail-soft — returns
 * null on any failure). A fetch that fails is simply skipped (no WebEvidence emitted for that
 * URL); an extraction that fails still keeps the real fetched text, with `extract.insights: null`.
 * This path has its own independent budget (MAX_NEWS_DIGESTS, per search_news step) and never
 * touches MAX_TAVILY_EXTRACTS. Two search_news steps' digest batches now run concurrently WITH
 * each other too (runStepsConcurrently), not just internally within one step.
 *
 * One optional re-plan: if any misses remain after the first pass, plan() is called ONCE more
 * with a synthetic follow-up question describing only the misses (never the evidence gathered so
 * far — see the plan's explicit "never the evidence" rule), the result is validated, and whatever
 * NEW steps come back are executed — then this function stops unconditionally, regardless of
 * whether misses still remain. "New" is judged by step CONTENT (tool + subject fields), not by
 * step id: a fresh plan() call restarts id numbering at "s1", so two structurally different steps
 * can share an id across the two plans, and comparing ids alone would wrongly skip a genuinely new
 * step (or wrongly re-run an identical one under a new id). A failure to re-plan (unconfigured
 * role, parse error, network error) is swallowed — the re-plan is optional enrichment, not a hard
 * dependency; the first pass's results and misses stand as-is, same fail-soft precedent as
 * summarizeArticle()/fetchArticleText().
 */
import { createHash } from 'node:crypto';
import {
  getSeriesEvidence,
  getSelectedCountrySeries,
  searchNews,
  getNewsCoverage,
  evidenceId,
  addComparabilityCaveats,
  validateResearchPlan,
} from '../askTools.js';
import { searchWeb, extractWeb } from '../webEvidence.js';
import { fetchArticleText } from '../newsArticleFetch.js';
import { extractArticleInsights } from './roles/newsExtract.js';
import { plan as planFollowUp } from './roles/plan.js';
import { MAX_TAVILY_SEARCHES, MAX_TAVILY_EXTRACTS, MAX_NEWS_DIGESTS } from './config.js';
import type {
  ResearchPlan,
  ResearchStep,
  ResearchIntent,
  EvidencePackage,
  WebEvidence,
  EvidenceMeta,
  EvidenceRef,
  NewsEvidence,
} from './contracts.js';

// News evidence is metadata-only (CLAUDE.md's standing rule) — pushed once, whenever any
// search_news step ran, exactly like buildEvidencePackage() does for the non-agentic path. The
// digest side path adds W: evidence (real fetched text) about the SAME article; it does not
// change what an N: ref itself may be treated as.
const NEWS_METADATA_ONLY_CAVEAT =
  'News evidence is headline metadata only — title, source, date and link. No article text is stored, so nothing may be reported as read from an article body.';

// ── Small helpers duplicated from webEvidence.ts (not exported there — see that file's own
//    "id per WebEvidence's documented shape" comment) so the news-digest WebEvidence entries this
//    file constructs directly use the exact same id/domain conventions as Tavily-backed ones. ──
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function hasRealUrl(n: NewsEvidence): boolean {
  return typeof n.url === 'string' && /^https?:\/\//i.test(n.url.trim());
}

/* A content signature per step, used ONLY to decide whether a re-planned step duplicates one
   already executed (see file header — step ids are not comparable across two separate plan()
   calls). Deliberately ignores `id` and `why` (bookkeeping/prose, not what the step DOES). */
function stepSignature(step: ResearchStep): string {
  switch (step.tool) {
    case 'get_series':
      return `get_series:${step.country}:${step.indicator}:${step.yearFrom}:${step.yearTo}`;
    case 'compare_series':
      return `compare_series:${[...step.countries].sort().join(',')}:${step.indicator}:${step.yearFrom}:${step.yearTo}`;
    case 'search_news':
      return `search_news:${[...step.countries].sort().join(',')}:${[...step.keywords].sort().join(',')}:${step.dateFrom}:${step.dateTo}`;
    case 'search_web':
      return `search_web:${step.query}:${step.dateFrom}:${step.dateTo}`;
    case 'extract_web':
      return `extract_web:${step.onStep}:${step.maxUrls}`;
  }
}

// scope.countries/indicators describe the STRUCTURE of the plan, not retrieved evidence — safe to
// reuse for a re-plan's synthetic intent and for the final addComparabilityCaveats() call, unlike
// pkg.data/pkg.news which the "never the evidence" rule forbids handing back to a model.
function inferQuestionType(researchPlan: ResearchPlan): ResearchIntent['questionType'] {
  if (researchPlan.steps.some(s => s.tool === 'compare_series')) return 'comparison';
  if (researchPlan.steps.length > 0 && researchPlan.steps.every(s => s.tool === 'search_news')) return 'news';
  return 'indicator';
}

function scopeToSyntheticIntent(researchPlan: ResearchPlan): ResearchIntent {
  return {
    questionType: inferQuestionType(researchPlan),
    countries: researchPlan.scope.countries,
    indicators: researchPlan.scope.indicators,
    yearFrom: researchPlan.scope.yearFrom,
    yearTo: researchPlan.scope.yearTo,
    newsKeywords: [],
  };
}

export async function executeResearchPlan(
  researchPlan: ResearchPlan,
  retrievedAt: string = new Date().toISOString(),
): Promise<EvidencePackage> {
  const pkg: EvidencePackage = {
    data: [],
    news: [],
    misses: [],
    caveats: [],
    toolsUsed: [],
    newsCoverage: getNewsCoverage(),
    web: [],
    evidenceMeta: [],
  };

  // Runtime-derived authorization state for extract_web — see file header. Populated ONLY as a
  // search_web step is actually dispatched and actually returns results; never from plan.steps
  // directly, and never from validateResearchPlan's own (separate, earlier) check.
  const searchWebResultsByStep = new Map<string, WebEvidence[]>();
  const executedSignatures = new Set<string>();
  let searchCalls = 0;
  let extractBudget = MAX_TAVILY_EXTRACTS;

  function pushTool(name: string): void {
    if (!pkg.toolsUsed.includes(name)) pkg.toolsUsed.push(name);
  }

  async function runNewsDigest(step: ResearchStep & { tool: 'search_news' }, results: NewsEvidence[]): Promise<void> {
    const candidates = results.filter(hasRealUrl).slice(0, MAX_NEWS_DIGESTS);
    const settled = await Promise.all(
      candidates.map(async (item): Promise<WebEvidence | null> => {
        const fetched = await fetchArticleText(item.url);
        if (!fetched) return null; // fetch failed — no evidence to emit for this article at all
        const insights = await extractArticleInsights({
          title: item.title,
          text: fetched.text,
          publishedDate: item.date ?? null,
        });
        return {
          id: `W:${sha256Hex(item.url)}`,
          title: item.title,
          url: item.url,
          domain: domainOf(item.url),
          publishedDate: item.date ?? null,
          retrievedAt: new Date().toISOString(),
          snippet: '',
          extract: { text: fetched.text, chars: fetched.chars, summary: null, insights },
          authorizedBy: step.id,
        };
      }),
    );
    for (const w of settled) if (w) pkg.web!.push(w);
  }

  async function runStep(step: ResearchStep): Promise<void> {
    executedSignatures.add(stepSignature(step));

    if (step.tool === 'get_series') {
      const { evidence, miss } = getSeriesEvidence(step.country, step.indicator, step.yearFrom, step.yearTo);
      if (evidence) pkg.data.push(evidence);
      if (miss) pkg.misses.push(miss);
      pushTool('getSeriesEvidence');
      return;
    }

    if (step.tool === 'compare_series') {
      const { evidence, misses } = getSelectedCountrySeries(step.countries, step.indicator, step.yearFrom, step.yearTo);
      pkg.data.push(...evidence);
      pkg.misses.push(...misses);
      pushTool('getSelectedCountrySeries');
      return;
    }

    if (step.tool === 'search_news') {
      const results = searchNews({
        countries: step.countries,
        keywords: step.keywords,
        dateFrom: step.dateFrom,
        dateTo: step.dateTo,
      });
      pkg.news.push(...results);
      pushTool('searchNews');
      if (!pkg.caveats.includes(NEWS_METADATA_ONLY_CAVEAT)) pkg.caveats.push(NEWS_METADATA_ONLY_CAVEAT);
      if (!results.length) {
        pkg.misses.push({ kind: 'news', detail: `search_news step "${step.id}" found no matching News Hub records.` });
      }
      await runNewsDigest(step, results);
      return;
    }

    if (step.tool === 'search_web') {
      if (searchCalls >= MAX_TAVILY_SEARCHES) {
        pkg.misses.push({
          kind: 'step',
          detail: `search_web step "${step.id}" skipped — Tavily search budget (${MAX_TAVILY_SEARCHES}) already spent this request.`,
        });
        return;
      }
      searchCalls += 1;
      const results = await searchWeb(step.query, step.dateFrom, step.dateTo);
      // searchWeb() deliberately leaves authorizedBy as '' (see webEvidence.ts) — the executor is
      // the only caller that knows which step authorized this call, so it MUST overwrite it here.
      const authorized: WebEvidence[] = results.map(r => ({ ...r, authorizedBy: step.id }));
      pkg.web!.push(...authorized);
      // This is what makes a LATER extract_web step's onStep check meaningful: the map only ever
      // gains an entry here, after a real search_web dispatch actually produced results.
      searchWebResultsByStep.set(step.id, authorized);
      pushTool('searchWeb');
      if (!authorized.length) {
        pkg.misses.push({ kind: 'step', detail: `search_web step "${step.id}" returned no results.` });
      }
      return;
    }

    // extract_web — see file header for the full authorization argument.
    const target = searchWebResultsByStep.get(step.onStep);
    if (!target || !target.length) {
      pkg.misses.push({
        kind: 'step',
        detail: `extract_web step "${step.id}" names onStep "${step.onStep}", which this executor never actually ran a search_web step for (or that step returned no results) — refusing to call Tavily Extract.`,
      });
      return;
    }
    if (extractBudget <= 0) {
      pkg.misses.push({
        kind: 'step',
        detail: `extract_web step "${step.id}" skipped — Tavily extract budget (${MAX_TAVILY_EXTRACTS}) already spent this request.`,
      });
      return;
    }
    const urlsToExtract = target.slice(0, Math.min(step.maxUrls, extractBudget)).map(w => w.url);
    extractBudget -= urlsToExtract.length;
    const extracted = await extractWeb(urlsToExtract);
    pushTool('extractWeb');
    for (const url of urlsToExtract) {
      const hit = extracted.get(url);
      // Same object reference as the one already pushed into pkg.web by the search_web branch
      // above — mutating it here populates `extract` in place. One URL, one evidence entry.
      const entry = target.find(w => w.url === url);
      if (hit && entry) entry.extract = { text: hit.text, chars: hit.chars, summary: null, insights: null };
    }
    const missingCount = urlsToExtract.length - extracted.size;
    if (missingCount > 0) {
      pkg.misses.push({
        kind: 'step',
        detail: `extract_web step "${step.id}" — Tavily Extract could not return body text for ${missingCount} of ${urlsToExtract.length} authorized URL(s).`,
      });
    }
  }

  /* Runs a batch of steps with maximum safe concurrency instead of one-at-a-time. Only extract_web
   * has a real data dependency — on the search_web step it names via onStep (see this file's own
   * "extract_web authorization" header section) — so every other step type starts immediately,
   * together. This is what took execute() from serial (e.g. two search_news steps' own concurrent
   * news-digest sub-batches running one after the other) to genuinely concurrent (both digest
   * batches, get_series, and search_web all running at once); only extract_web still waits, and
   * only for the one step it is actually authorized by.
   *
   * Correctness under concurrency, argued once here rather than at every call site:
   *   - `steps.map()` runs its callback synchronously, in array order. Calling an async function
   *     also runs its body SYNCHRONOUSLY up to its first await. So every step's synchronous
   *     prefix — executedSignatures.add(), the searchCalls/extractBudget check-then-mutate pairs,
   *     which all happen before their own first `await` inside runStep() — still executes in
   *     exact plan order, one full prefix at a time, before the next step's prefix begins. Budget
   *     consumption order is therefore unchanged from strictly sequential execution; only the
   *     slow I/O after each prefix (Tavily calls, article fetches, model calls) now overlaps.
   *   - `stepPromises.set(step.id, promise)` happens only AFTER that step's own synchronous
   *     prefix has run (including its own onStep lookup, if it's an extract_web step) — so a step
   *     can never see itself in the map, and an extract_web step's onStep lookup only ever finds
   *     an earlier step's promise, exactly matching validateResearchPlan's "onStep must name an
   *     earlier step" invariant. An onStep naming a step id this batch never ran (a hand-crafted
   *     plan, or a real step of the wrong tool) finds nothing here, awaits nothing, and falls
   *     through to runStep()'s own searchWebResultsByStep authorization check exactly as before —
   *     this function only ever adds a wait; it never weakens what that check allows. */
  async function runStepsConcurrently(steps: ResearchStep[]): Promise<void> {
    const stepPromises = new Map<string, Promise<void>>();
    const promises = steps.map(step => {
      const promise = (async () => {
        if (step.tool === 'extract_web') {
          const dep = stepPromises.get(step.onStep);
          if (dep) await dep;
        }
        await runStep(step);
      })();
      stepPromises.set(step.id, promise);
      return promise;
    });
    await Promise.all(promises);
  }

  await runStepsConcurrently(researchPlan.steps);

  // ── One optional re-plan ──────────────────────────────────────────────────────────────────
  if (pkg.misses.length > 0) {
    try {
      const missSummary = pkg.misses.map(m => `- (${m.kind}) ${m.detail}`).join('\n');
      const followUpQuestion = [
        `Automatic follow-up planning pass for the original question: "${researchPlan.question}"`,
        'The first research pass could not retrieve the following. Plan ONLY new steps that might',
        'close these specific gaps — do not repeat ground already covered, and do not answer the',
        'question yourself:',
        missSummary,
      ].join('\n');

      const rawReplan = await planFollowUp(followUpQuestion, scopeToSyntheticIntent(researchPlan));
      const { plan: validatedReplan, misses: replanMisses } = validateResearchPlan(rawReplan);
      pkg.misses.push(...replanMisses);

      // A fresh plan() call restarts id numbering at "s1" (file header) with no knowledge of pass
      // 1's ids, so any extract_web.onStep in this replan can only ever mean "a step in THIS
      // replan" — never a deliberate reference back to pass 1. Clearing the map here prevents a
      // pass-2 id (e.g. "s1") that collides with a pass-1 id from being authorized by pass 1's
      // stale entry when pass 2's own same-id search_web step is itself skipped (budget already
      // spent) and therefore never repopulates it.
      searchWebResultsByStep.clear();

      const newSteps = validatedReplan.steps.filter(s => !executedSignatures.has(stepSignature(s)));
      await runStepsConcurrently(newSteps);
    } catch {
      // plan() throws PlanNotConfiguredError/PlanParseError when unconfigured or unparseable.
      // The re-plan is optional enrichment (docs plan §2d) — swallow and keep the first pass's
      // results, the same fail-soft precedent as summarizeArticle()/fetchArticleText() elsewhere
      // in this pipeline. Never a second attempt, regardless of why this one failed.
    }
  }

  addComparabilityCaveats(pkg, scopeToSyntheticIntent(researchPlan));

  // Mirrors buildEvidencePackage()'s own evidenceMeta construction exactly (askTools.ts), extended
  // with a W: entry per web evidence item. D:/N: use the caller-supplied `retrievedAt` (the moment
  // of the actual request, per buildEvidencePackage's own doc comment); W: uses each entry's OWN
  // retrievedAt, since unlike the local hub, web evidence "moves under you" per-fetch (contracts.ts).
  pkg.evidenceMeta = [
    ...pkg.data.map((d): EvidenceMeta => ({
      ref: `D:${evidenceId(d.country, d.indicator)}`,
      vintage: d.vintage,
      retrievedAt,
      sourceRevisionDate: null,
      contentHash: null,
    })),
    ...pkg.news.map((n): EvidenceMeta => ({
      ref: `N:${n.id}`,
      vintage: null,
      retrievedAt,
      sourceRevisionDate: null,
      contentHash: null,
    })),
    ...(pkg.web ?? []).map((w): EvidenceMeta => ({
      ref: w.id as EvidenceRef,
      vintage: null,
      retrievedAt: w.retrievedAt,
      sourceRevisionDate: null,
      contentHash: null,
    })),
  ];

  return pkg;
}
