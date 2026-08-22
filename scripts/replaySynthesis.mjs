/* Capture one real completed EvidencePackage and replay its exact synthesis messages repeatedly.
 *
 * This is a deliberately manual latency diagnostic: it spends real provider tokens and writes
 * the retrieved evidence (which can include web extracts) only beneath ignored .tmp/. It never
 * writes API keys, request headers, raw provider text, or model reasoning.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/replaySynthesis.mjs --question "..." [--runs 5] [--out .tmp/...]
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { interpret } from '../src/lib/ai/roles/interpret.ts';
import { plan } from '../src/lib/ai/roles/plan.ts';
import {
  SYNTHESIS_MODEL_OPTIONS,
  buildSynthesisMessages,
  parseSynthesisResponse,
} from '../src/lib/ai/roles/synthesize.ts';
import { validateResearchPlan } from '../src/lib/askTools.ts';
import { executeResearchPlan } from '../src/lib/ai/executor.ts';
import { compileEvidence } from '../src/lib/ai/evidenceCompiler.ts';
import { resolveRoleFully } from '../src/lib/ai/config.ts';
import { callModel } from '../src/lib/ai/providers/openaiCompatible.ts';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] ?? fallback;
}

const question = argument('--question');
const runs = Number(argument('--runs', '5'));
const defaultOut = `.tmp/synthesis-replay-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
const outPath = argument('--out', defaultOut);

if (!question || !question.trim()) throw new Error('Usage requires --question "...".');
if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error('--runs must be an integer from 1 to 20.');

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function write(output) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
}

const captureStarted = performance.now();
const { intent, misses: intentMisses } = await interpret(question);
const rawPlan = await plan(question, intent);
const { plan: validatedPlan, misses: planMisses } = validateResearchPlan(rawPlan);
const evidence = await executeResearchPlan(validatedPlan);
evidence.misses = [...intentMisses, ...planMisses, ...evidence.misses];
const compiled = compileEvidence(intent, validatedPlan, evidence);

const promptStarted = performance.now();
const messages = buildSynthesisMessages(compiled);
const promptBuildMs = performance.now() - promptStarted;
const messageJson = JSON.stringify(messages);
const promptMetrics = {
  hash: hash(messageJson),
  chars: messages.reduce((total, message) => total + message.content.length, 0),
  bytes: Buffer.byteLength(messageJson),
  messageCount: messages.length,
  promptBuildMs: Number(promptBuildMs.toFixed(3)),
};

const resolved = resolveRoleFully('synthesis');
if (!resolved) throw new Error('The configured synthesis provider/model is not ready. Check CARIBECON_SYNTHESIS_* and its connection.');

const output = {
  schemaVersion: 1,
  purpose: 'fixed-input synthesis latency replay',
  capturedAt: new Date().toISOString(),
  capturePipelineMs: Number((performance.now() - captureStarted).toFixed(3)),
  question,
  provider: { name: resolved.provider, model: resolved.model },
  transport: {
    streaming: false,
    timeToFirstTokenMs: null,
    timeToFirstTokenNote: 'The production OpenAI-compatible adapter is non-streaming; timeToResponseHeadersMs is TTFB, not TTFT.',
  },
  synthesisInput: { ...promptMetrics, messages },
  intent,
  validatedPlan,
  evidence,
  compiledEvidence: compiled,
  replays: [],
};

write(output);
console.log(`Captured fixed synthesis input (${promptMetrics.chars} chars, sha256 ${promptMetrics.hash.slice(0, 12)}…) to ${outPath}`);

for (let index = 1; index <= runs; index += 1) {
  let responseHeadersMs = null;
  const stageStarted = performance.now();
  try {
    const response = await callModel(resolved.connection, resolved.model, messages, {
      ...SYNTHESIS_MODEL_OPTIONS,
      onResponseHeaders: elapsedMs => {
        responseHeadersMs = elapsedMs;
      },
    });
    const modelCallMs = performance.now() - stageStarted;
    const parseStarted = performance.now();
    const answer = parseSynthesisResponse(response);
    const parseAndCoerceMs = performance.now() - parseStarted;
    output.replays.push({
      run: index,
      ok: true,
      promptTokens: response.usage?.promptTokens ?? null,
      completionTokens: response.usage?.completionTokens ?? null,
      returnedTextChars: response.text.length,
      finishReason: response.finishReason,
      timeToResponseHeadersMs: responseHeadersMs === null ? null : Number(responseHeadersMs.toFixed(3)),
      modelCallMs: Number(modelCallMs.toFixed(3)),
      parseAndCoerceMs: Number(parseAndCoerceMs.toFixed(3)),
      totalSynthesisStageMs: Number((performance.now() - stageStarted).toFixed(3)),
      visibleClaims: answer.claims.length,
      visibleAnswerChars: answer.headline.length + answer.claims.reduce((total, claim) => total + claim.text.length, 0),
    });
  } catch (error) {
    output.replays.push({
      run: index,
      ok: false,
      error: error?.constructor?.name ?? 'Error',
      message: String(error?.message ?? error),
      timeToResponseHeadersMs: responseHeadersMs === null ? null : Number(responseHeadersMs.toFixed(3)),
      totalSynthesisStageMs: Number((performance.now() - stageStarted).toFixed(3)),
    });
  }
  write(output);
  const replay = output.replays.at(-1);
  console.log(`Replay ${index}/${runs}: ${replay.ok ? `${(replay.totalSynthesisStageMs / 1000).toFixed(2)}s` : `FAILED (${replay.error})`}`);
}

console.log(`Wrote replay results to ${outPath}`);
