/* Live-audit sweep comparing the staged interpret()+plan() path against one or more candidate
 * models for the combined routePlan() role (plans/interpret-plan-merge-latency-review.md §7 Step
 * 3: "unit tests, then a live-audit sweep across real questions ... checking specifically: miss
 * accuracy vs. staged baseline, plan quality (right tools, no over-planning), structured-output
 * failure rate, and measured latency delta." §7 Step 0 asked for per-stage timing before merging
 * anything — nothing in the repo logs that yet, so this script measures it directly by calling
 * interpret()+plan() and routePlan() in isolation, rather than through the full research()
 * pipeline where execute()/synthesize() latency would drown out the one delta this change makes.
 *
 * Also doubles as the CARIBECON_ROUTEPLAN_* model bake-off §1.3 of the plan doc calls for
 * ("resolved with a real benchmark, not assumed") — CANDIDATES below can list more than one
 * provider/model pair for the combined call; each runs against the same question set so their
 * latency/plan-quality/miss-accuracy are directly comparable.
 *
 * Spends real provider tokens: two calls per question for staged (interpret+plan), plus one call
 * per question per candidate. Run deliberately, not in CI. Modeled on
 * scripts/captureAskFixtures.mjs's own question set and its policy that a failure is a data
 * point, not a reason to abort the run.
 *
 * Usage: npx tsx --env-file=.env scripts/routeplanBenchmark.mjs [--out <path>] [--only <label>]
 *        [--repeat <n>]
 *   --only <label>    Restrict CANDIDATES to the one(s) whose label matches (exact match, or
 *                      comma-separated list of labels) — e.g. `--only default` to bake off just
 *                      the .env-configured candidate without spending tokens on the others.
 *   --repeat <n>       Run every question n times (default 1) against every retained candidate,
 *                      to see whether a result is stable across repeated calls at temperature 0
 *                      (§7 Step 3's "byte-identical" check needs more than one sample to trust).
 */
import fs from 'node:fs';
import path from 'node:path';
import { interpret } from '../src/lib/ai/roles/interpret.ts';
import { plan } from '../src/lib/ai/roles/plan.ts';
import { routePlan } from '../src/lib/ai/roles/routePlan.ts';

const outFlagIndex = process.argv.indexOf('--out');
const OUT_PATH = outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : 'scripts/.routeplan-benchmark-report.json';

const onlyFlagIndex = process.argv.indexOf('--only');
const ONLY_LABELS = onlyFlagIndex !== -1 ? process.argv[onlyFlagIndex + 1].split(',').map((s) => s.trim()) : null;

const repeatFlagIndex = process.argv.indexOf('--repeat');
const REPEAT = repeatFlagIndex !== -1 ? Number(process.argv[repeatFlagIndex + 1]) : 1;

// Skip the staged interpret()+plan() arm entirely. The staged baseline does not change between
// candidate runs, so once it has been captured there is no reason to re-spend two model calls per
// question re-measuring it — it only adds cost and MiniMax-timeout noise to a candidate sweep.
const SKIP_STAGED = process.argv.includes('--skip-staged');

const categoryFlagIndex = process.argv.indexOf('--category');
const ONLY_CATEGORIES =
  categoryFlagIndex !== -1 ? process.argv[categoryFlagIndex + 1].split(',').map((s) => s.trim()) : null;

// Candidate provider/model pairs for the combined routePlan() call. The first entry mirrors
// whatever CARIBECON_ROUTEPLAN_PROVIDER/_MODEL is currently set to in .env (today's configured
// default, Nebius Qwen3-30B-A3B-Instruct-2507) so it stays the baseline candidate without having
// to duplicate the value here. Add more candidates to widen the bake-off.
const ALL_CANDIDATES = [
  {
    label: 'default (.env CARIBECON_ROUTEPLAN_*)',
    provider: process.env.CARIBECON_ROUTEPLAN_PROVIDER,
    model: process.env.CARIBECON_ROUTEPLAN_MODEL,
  },
  {
    label: 'hermes-4-70b',
    provider: 'nebius',
    model: 'NousResearch/Hermes-4-70B',
  },
  /* Both Nemotron ids below are copied verbatim from what the configured Nebius account actually
     serves (GET /models), not constructed from a product name — there is no
     "Nemotron-3_5-Lightning-30B-A3B" in the catalog, so the two plausible readings of that name
     are benchmarked separately rather than guessed at:
       - Nemotron-3_5-Lightning is the "3.5 Lightning" name match, and is already the model
         CARIBECON_INTERPRET_MODEL uses for the staged interpret role.
       - NVIDIA-Nemotron-3-Nano-30B-A3B is the "30B-A3B" size match, but it is Nemotron 3 Nano. */
  {
    label: 'nemotron-3.5-lightning',
    provider: 'nebius',
    model: 'nvidia/Nemotron-3_5-Lightning',
  },
  {
    label: 'nemotron-3-nano-30b-a3b',
    provider: 'nebius',
    model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  },
  /* The one reasoning ("Thinking") model in the set — included to answer the QUALITY-first
     question, explicitly not the latency one: it is expected to be slower than every candidate
     above, and that is not the finding under test. Two config ceilings in routePlan() may bind
     before its plan quality is even observable, so read failures carefully rather than as verdicts
     on the model: maxTokens: 16_000 is spent on its reasoning trace before any JSON is emitted (a
     finishReason of "length" means the budget ran out mid-answer), and timeoutMs: 45_000 caps the
     whole call. A visible trace also has to be stripped before parseModelJson() can read the
     result — it handles ```json fences, not prose preambles — which surfaces as
     RoutePlanParseError. */
  {
    label: 'qwen3-next-80b-thinking',
    provider: 'nebius',
    model: 'Qwen/Qwen3-Next-80B-A3B-Thinking',
  },
];

// Substring match, not exact — so `--only default` matches the full label
// "default (.env CARIBECON_ROUTEPLAN_*)" without having to quote the whole thing. Case-insensitive
// for the same reason.
const CANDIDATES = ONLY_LABELS
  ? ALL_CANDIDATES.filter((c) =>
      ONLY_LABELS.some((token) => c.label.toLowerCase().includes(token.toLowerCase())),
    )
  : ALL_CANDIDATES;

// Fail closed: a --only filter that matches nothing must stop the run before it spends a single
// provider call, not silently proceed with an empty CANDIDATES array (which used to make every
// question print "ok" for staged only and quietly report zero rows for the arm actually under
// test — a benchmark that measures nothing must never look like a benchmark that succeeded).
if (ONLY_LABELS && CANDIDATES.length === 0) {
  console.error(`--only ${ONLY_LABELS.join(',')} matched no candidate.`);
  console.error(`Available labels: ${ALL_CANDIDATES.map((c) => c.label).join(', ')}`);
  process.exit(1);
}

// Same twelve questions as captureAskFixtures.mjs's QUESTIONS, so this run is directly comparable
// to the existing askCaptures.json fixture set's category coverage.
const QUESTIONS = [
  { category: 'simple_factual', question: "What was Guyana's GDP growth in 2024?" },
  { category: 'time_series', question: 'How has Jamaican inflation changed since 2020?' },
  { category: 'comparison', question: 'Compare Guyana and Trinidad debt levels.' },
  { category: 'news_current_context', question: 'What recent developments are affecting Barbados tourism?' },
  { category: 'research_question', question: 'Is Guyana showing signs of Dutch disease?' },
  { category: 'multi_source', question: "How have higher oil revenues affected Guyana's fiscal position?" },
  { category: 'ambiguous', question: 'How is Trinidad doing?' },
  { category: 'regional', question: 'Which Caribbean economies have the highest debt burdens?' },
  { category: 'out_of_hub_country', question: "What is Cuba's inflation rate?" },
  { category: 'out_of_range_years', question: "What was Guyana's GDP in 1990?" },
  { category: 'multi_country_comparison', question: 'Compare debt-to-GDP across Jamaica, Barbados, and Guyana.' },
  { category: 'vague_short', question: 'Guyana economy?' },
];

// Same fail-closed rule as --only above: a --category filter that matches nothing stops the run
// before spending a provider call, rather than "succeeding" over an empty question set.
const SELECTED_QUESTIONS = ONLY_CATEGORIES
  ? QUESTIONS.filter((q) => ONLY_CATEGORIES.includes(q.category))
  : QUESTIONS;

if (ONLY_CATEGORIES && SELECTED_QUESTIONS.length === 0) {
  console.error(`--category ${ONLY_CATEGORIES.join(',')} matched no question.`);
  console.error(`Available categories: ${QUESTIONS.map((q) => q.category).join(', ')}`);
  process.exit(1);
}

function planShape(researchPlan) {
  return {
    stepCount: researchPlan.steps.length,
    tools: researchPlan.steps.map((s) => s.tool),
  };
}

async function runStaged(question) {
  const startedAt = Date.now();
  const interpreted = await interpret(question);
  const interpretMs = Date.now() - startedAt;
  const planStarted = Date.now();
  const researchPlan = await plan(question, interpreted.intent);
  const planMs = Date.now() - planStarted;
  return {
    totalMs: Date.now() - startedAt,
    interpretMs,
    planMs,
    questionType: interpreted.intent.questionType,
    countries: interpreted.intent.countries,
    indicators: interpreted.intent.indicators,
    missCount: interpreted.misses.length,
    missKinds: interpreted.misses.map((m) => m.kind),
    ...planShape(researchPlan),
  };
}

// Overrides CARIBECON_ROUTEPLAN_PROVIDER/_MODEL for the duration of one call — resolveRole()
// (config.ts) reads process.env fresh per call, so this is enough to point routePlan() at a
// different candidate without touching config plumbing, and the finally block leaves .env's own
// values intact for the next candidate/question.
async function runCombined(question, candidate) {
  const prevProvider = process.env.CARIBECON_ROUTEPLAN_PROVIDER;
  const prevModel = process.env.CARIBECON_ROUTEPLAN_MODEL;
  process.env.CARIBECON_ROUTEPLAN_PROVIDER = candidate.provider;
  process.env.CARIBECON_ROUTEPLAN_MODEL = candidate.model;
  try {
    const startedAt = Date.now();
    const routed = await routePlan(question);
    const totalMs = Date.now() - startedAt;
    return {
      totalMs,
      questionType: routed.intent.questionType,
      countries: routed.intent.countries,
      indicators: routed.intent.indicators,
      missCount: routed.misses.length,
      missKinds: routed.misses.map((m) => m.kind),
      usage: routed.usage,
      finishReason: routed.finishReason,
      ...planShape(routed.plan),
    };
  } finally {
    process.env.CARIBECON_ROUTEPLAN_PROVIDER = prevProvider;
    process.env.CARIBECON_ROUTEPLAN_MODEL = prevModel;
  }
}

async function main() {
  const rows = [];

  for (const { category, question } of SELECTED_QUESTIONS) {
    for (let repetition = 1; repetition <= REPEAT; repetition += 1) {
      const repTag = REPEAT > 1 ? ` (rep ${repetition}/${REPEAT})` : '';
      process.stdout.write(`[${category}] ${question}${repTag}\n`);
      const row = { category, question, repetition, capturedAt: new Date().toISOString(), combined: {} };

      if (SKIP_STAGED) {
        row.staged = { skipped: true };
      } else {
      process.stdout.write('  staged (interpret+plan)   ... ');
      try {
        row.staged = await runStaged(question);
        console.log(
          `ok (${row.staged.totalMs}ms = interpret ${row.staged.interpretMs}ms + plan ${row.staged.planMs}ms, ` +
            `${row.staged.stepCount} steps, ${row.staged.missCount} misses)`,
        );
      } catch (error) {
        row.staged = { error: { name: error?.constructor?.name ?? 'Error', message: String(error?.message ?? error) } };
        console.log(`FAILED: ${row.staged.error.name}: ${row.staged.error.message}`);
      }
      }

      for (const candidate of CANDIDATES) {
        process.stdout.write(`  combined [${candidate.label}] (${candidate.provider}/${candidate.model}) ... `);
        try {
          const result = await runCombined(question, candidate);
          row.combined[candidate.label] = result;
          console.log(
            `ok (${result.totalMs}ms, ${result.stepCount} steps, ${result.missCount} misses, finishReason=${result.finishReason})`,
          );
        } catch (error) {
          row.combined[candidate.label] = {
            error: { name: error?.constructor?.name ?? 'Error', message: String(error?.message ?? error) },
          };
          console.log(`FAILED: ${row.combined[candidate.label].error.name}: ${row.combined[candidate.label].error.message}`);
        }
      }

      rows.push(row);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2) + '\n');

  console.log('\n--- summary ---');
  const stagedOk = rows.filter((r) => !r.staged.error);
  if (SKIP_STAGED) {
    console.log(`questions: ${rows.length}, staged: skipped (--skip-staged)`);
  } else {
    const avgStaged = stagedOk.length ? Math.round(stagedOk.reduce((s, r) => s + r.staged.totalMs, 0) / stagedOk.length) : null;
    console.log(`questions: ${rows.length}, staged ok: ${stagedOk.length}/${rows.length}, avg staged total: ${avgStaged}ms`);
  }

  for (const candidate of CANDIDATES) {
    const ok = rows.filter((r) => (SKIP_STAGED || !r.staged.error) && r.combined[candidate.label] && !r.combined[candidate.label].error);
    const failures = rows.filter((r) => r.combined[candidate.label]?.error).length;
    if (!ok.length) {
      console.log(`\n[${candidate.label}] ${candidate.provider}/${candidate.model}: 0/${rows.length} ok, ${failures} failed`);
      continue;
    }
    const avgCombined = Math.round(ok.reduce((s, r) => s + r.combined[candidate.label].totalMs, 0) / ok.length);
    const avgSteps = Math.round((ok.reduce((s, r) => s + r.combined[candidate.label].stepCount, 0) / ok.length) * 10) / 10;
    const totalMisses = ok.reduce((s, r) => s + r.combined[candidate.label].missCount, 0);
    console.log(`\n[${candidate.label}] ${candidate.provider}/${candidate.model}: ${ok.length}/${rows.length} ok, ${failures} failed`);
    console.log(`  avg combined total: ${avgCombined}ms`);
    console.log(`  avg plan steps: ${avgSteps}`);
    console.log(`  total misses: ${totalMisses}`);
    if (!SKIP_STAGED) {
      const avgDelta = Math.round(ok.reduce((s, r) => s + (r.combined[candidate.label].totalMs - r.staged.totalMs), 0) / ok.length);
      const avgStagedSteps = Math.round((ok.reduce((s, r) => s + r.staged.stepCount, 0) / ok.length) * 10) / 10;
      const totalStagedMisses = ok.reduce((s, r) => s + r.staged.missCount, 0);
      console.log(`  vs staged: avg delta ${avgDelta}ms (${avgDelta < 0 ? 'faster' : 'slower'}), staged steps ${avgStagedSteps}, staged misses ${totalStagedMisses}`);
    }
  }

  console.log(`\nWrote ${rows.length} rows to ${OUT_PATH}`);
}

main();
