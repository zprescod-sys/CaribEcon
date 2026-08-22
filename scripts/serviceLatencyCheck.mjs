/* Full-service, end-to-end latency check for research() (src/lib/ai/research.ts) — the whole
 * pipeline (route_plan/interpret+plan -> execute -> synthesize -> verify), not routePlan() or
 * interpret()+plan() in isolation the way scripts/routeplanBenchmark.mjs measures. This is what
 * actually reaches a user: plans/interpret-plan-merge-latency-review.md §7 Step 0's per-stage
 * instrumentation now lives in research.ts itself (console.log('research: stage timings', ...)),
 * captured here per question/mode rather than read off server logs.
 *
 * Spends real provider tokens for the FULL pipeline per call (route_plan/interpret+plan, every
 * execute() sub-call including news/web fan-out, synthesize, verify) — the most expensive script
 * in this repo's benchmark set. Run deliberately, not in CI.
 *
 * Usage: npx tsx --env-file=.env scripts/serviceLatencyCheck.mjs [--out <path>] [--mode combined|staged|both]
 */
import fs from 'node:fs';
import path from 'node:path';
import { research } from '../src/lib/ai/research.ts';

const outFlagIndex = process.argv.indexOf('--out');
const OUT_PATH = outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : 'scripts/.service-latency-report.json';

const modeFlagIndex = process.argv.indexOf('--mode');
const MODE = modeFlagIndex !== -1 ? process.argv[modeFlagIndex + 1] : 'both';
const MODES = MODE === 'both' ? ['combined', 'staged'] : [MODE];

const categoryFlagIndex = process.argv.indexOf('--category');
const ONLY_CATEGORIES =
  categoryFlagIndex !== -1 ? process.argv[categoryFlagIndex + 1].split(',').map(s => s.trim()) : null;

// Same twelve questions as routeplanBenchmark.mjs/captureAskFixtures.mjs.
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

// research() itself logs the stage timings via console.log('research: stage timings', {...}) —
// intercept just that one line per call rather than duplicating the timing logic here, so this
// script can never drift from what research.ts actually measures.
async function runWithCapturedTimings(question) {
  let captured = null;
  const originalLog = console.log;
  console.log = (...args) => {
    if (args[0] === 'research: stage timings') {
      captured = args[1];
    } else {
      originalLog(...args);
    }
  };
  try {
    const result = await research({ question });
    return { result, timings: captured };
  } finally {
    console.log = originalLog;
  }
}

async function main() {
  const rows = [];
  const selectedQuestions = ONLY_CATEGORIES
    ? QUESTIONS.filter(q => ONLY_CATEGORIES.includes(q.category))
    : QUESTIONS;
  if (ONLY_CATEGORIES && !selectedQuestions.length) {
    console.error(`--category ${ONLY_CATEGORIES.join(',')} matched no question.`);
    console.error(`Available categories: ${QUESTIONS.map(q => q.category).join(', ')}`);
    process.exit(1);
  }

  for (const mode of MODES) {
    // process.env values are always strings, so assigning `undefined` would coerce to the literal
    // string "undefined" (truthy, and != 'staged' — harmless here, but a real footgun) rather than
    // unsetting the var. delete is the only correct way to simulate "unset" for the combined case.
    if (mode === 'staged') {
      process.env.CARIBECON_ROUTE_MODE = 'staged';
    } else {
      delete process.env.CARIBECON_ROUTE_MODE;
    }

    for (const { category, question } of selectedQuestions) {
      process.stdout.write(`[${mode}] [${category}] ${question} ... `);
      const row = { mode, category, question, capturedAt: new Date().toISOString() };
      try {
        const { result, timings } = await runWithCapturedTimings(question);
        row.timings = timings;
        row.verdict = result.verdict.outcome;
        row.claimCount = result.answer.claims.length;
        row.figureCount = result.evidence.data.length;
        row.missCount = result.evidence.misses.length;
        console.log(
          `ok — total ${timings?.totalMs}ms (${Object.entries(timings ?? {})
            .filter(([k]) => k !== 'totalMs' && k !== 'mode')
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')}), verdict=${row.verdict}, claims=${row.claimCount}, misses=${row.missCount}`,
        );
      } catch (error) {
        row.error = { name: error?.constructor?.name ?? 'Error', message: String(error?.message ?? error) };
        console.log(`FAILED: ${row.error.name}: ${row.error.message}`);
      }
      rows.push(row);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(rows, null, 2) + '\n');

  console.log('\n--- summary ---');
  for (const mode of MODES) {
    const modeRows = rows.filter(r => r.mode === mode && r.timings);
    if (!modeRows.length) {
      console.log(`[${mode}] 0/${selectedQuestions.length} ok`);
      continue;
    }
    const avg = key => Math.round(modeRows.reduce((s, r) => s + (r.timings[key] ?? 0), 0) / modeRows.length);
    const failures = rows.filter(r => r.mode === mode && r.error).length;
    console.log(`\n[${mode}] ${modeRows.length}/${selectedQuestions.length} ok, ${failures} failed`);
    const keys = Object.keys(modeRows[0].timings).filter(k => k !== 'mode');
    for (const k of keys) console.log(`  avg ${k}: ${avg(k)}ms`);
    const maxTotal = Math.max(...modeRows.map(r => r.timings.totalMs));
    const maxRow = modeRows.find(r => r.timings.totalMs === maxTotal);
    console.log(`  slowest: "${maxRow.question}" — ${maxTotal}ms`);
  }

  console.log(`\nWrote ${rows.length} rows to ${OUT_PATH}`);
}

main();
