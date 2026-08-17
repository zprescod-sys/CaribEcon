/* Captures real model outputs from the live Ask CaribEcon pipeline (src/lib/ai/research.ts)
 * for the fixture set BUILD_PLAN.md's Phase 1 calls for: "Capture real model outputs to a
 * fixture file. Phase 2's gate is calibrated against these."
 *
 * Spends real provider tokens — each question is one interpret() call and one synthesize()
 * call against whatever CARIBECON_INTERPRET_PROVIDER/CARIBECON_SYNTHESIS_PROVIDER resolve to.
 * Run deliberately, not in CI. A question that fails (unconfigured role, unparseable model
 * output) is recorded with its error, not allowed to abort the rest of the run — a partial
 * capture is still useful, and a failure IS a data point for gate calibration.
 *
 * Usage: npx tsx scripts/captureAskFixtures.mjs [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { research } from '../src/lib/ai/research.ts';

const outFlagIndex = process.argv.indexOf('--out');
const OUT_PATH = outFlagIndex !== -1 ? process.argv[outFlagIndex + 1] : 'src/lib/ai/fixtures/askCaptures.json';

// Deliberately spans question types Phase 1's interpret() actually supports (indicator/
// comparison/news) plus questions that don't map cleanly onto any of them — the latter are
// exactly what tells Phase 3's planner what it needs to add, and what tells Phase 2's gate
// what an under-evidenced answer looks like in practice.
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

function providerRecord() {
  return {
    interpret: { provider: process.env.CARIBECON_INTERPRET_PROVIDER ?? null, model: process.env.CARIBECON_INTERPRET_MODEL ?? null },
    synthesis: { provider: process.env.CARIBECON_SYNTHESIS_PROVIDER ?? null, model: process.env.CARIBECON_SYNTHESIS_MODEL ?? null },
  };
}

async function main() {
  const captures = [];

  for (const { category, question } of QUESTIONS) {
    const startedAt = Date.now();
    process.stdout.write(`[${category}] ${question} ... `);
    const base = { category, question, capturedAt: new Date().toISOString(), providers: providerRecord() };

    try {
      const result = await research({ question });
      const elapsedMs = Date.now() - startedAt;
      captures.push({ ...base, elapsedMs, result, error: null });
      console.log(`ok (${elapsedMs}ms, ${result.answer.claims.length} claims, ${result.evidence.misses.length} misses)`);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      captures.push({
        ...base,
        elapsedMs,
        result: null,
        error: { name: error?.constructor?.name ?? 'Error', message: String(error?.message ?? error) },
      });
      console.log(`FAILED (${elapsedMs}ms): ${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(captures, null, 2) + '\n');
  console.log(`\nWrote ${captures.length} captures to ${OUT_PATH}`);
}

main();
