/* interpret() — the first of six role functions (ARCHITECTURE.md §3.1: "interpret(question,
 * history) -> ResearchIntent... reuses canonicaliseIntent"). Its only job is turning free text
 * into the SAME validated intent shape the Excel picker already produces — it proposes, it never
 * decides. Every country and indicator name the model emits still passes through
 * resolveCountry/resolveIndicator exactly as canonicaliseIntent already enforces for picker
 * input; a plausible-looking hallucinated slug is stripped and recorded as a RetrievalMiss, the
 * same as any other unresolvable input. This function adds NOTHING to that validation — it only
 * gets a model to produce the raw JSON canonicaliseIntent already knows how to check.
 *
 * One model call, no tool loop (§2.3(a)'s governing principle): the country/indicator catalog is
 * embedded directly in the system prompt rather than exposed as a callable tool, because both
 * lists are small (19 countries, 24 indicators) and a single grounded call is simpler and
 * cheaper than a round-trip the model would have to initiate itself.
 */
import { resolveRoleFully } from '../config.js';
import { callModel, type ChatMessage } from '../providers/openaiCompatible.js';
import { parseModelJson } from './parseModelJson.js';
import {
  canonicaliseIntent,
  listCountries,
  listIndicators,
  type RetrievalMiss,
} from '../../askTools.js';
import type { ResearchIntent } from '../contracts.js';

export class InterpretNotConfiguredError extends Error {}

/* Distinct from a RetrievalMiss on purpose: a miss means "the model named something real
   evidence doesn't cover," which canonicaliseIntent already reports faithfully. This means "the
   model's output could not even be read as an intent" — a failure of the interpret step itself,
   not a fact about hub coverage. Folding it into misses (as an empty intent with no misses,
   which is what canonicaliseIntent(null) alone would silently produce) would let a total
   interpretation failure look identical to "an in-scope, well-formed question." */
export class InterpretParseError extends Error {
  constructor(public readonly rawText: string) {
    super('The model did not return parseable JSON for intent extraction.');
  }
}

export interface InterpretResult {
  intent: ResearchIntent;
  misses: RetrievalMiss[];
}

function buildSystemPrompt(): string {
  const countries = listCountries()
    .map(c => `${c.code}=${c.name}`)
    .join(', ');
  const indicators = listIndicators()
    .map(i => `${i.slug}=${i.label}`)
    .join(', ');

  return [
    'You turn a question about Caribbean macroeconomics into structured JSON so a deterministic',
    'retrieval layer can look up real data. You never answer the question yourself, and naming a',
    'country or indicator that is not in the lists below is fine — it will be reported as',
    'unavailable rather than guessed, so do not avoid a name just because you are unsure of it.',
    '',
    `Countries in the hub (code=name): ${countries}`,
    `Indicators in the hub (slug=label): ${indicators}`,
    '',
    'Respond with ONLY a JSON object in exactly this shape — no prose, no markdown fences:',
    '{"questionType":"indicator"|"comparison"|"news","countries":string[],"indicators":string[],"yearFrom":number|null,"yearTo":number|null,"newsKeywords":string[]}',
    '',
    '- "comparison" is for comparing 2+ economies on one indicator.',
    '- "news" is for questions about recent events, not a specific data series.',
    '- Either the code or the name resolves for a country — use whichever the question used.',
    '- yearFrom/yearTo are null unless the question names a specific year or range.',
    '- newsKeywords are only used for "news" questions: short terms, not the question restated.',
  ].join('\n');
}

export async function interpret(question: string): Promise<InterpretResult> {
  const resolved = resolveRoleFully('interpret');
  if (!resolved) {
    throw new InterpretNotConfiguredError(
      'CARIBECON_INTERPRET_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* Both numbers below are headroom for reasoning, not an estimate of the JSON's own size —
       thinking stays ON deliberately (the project's own choice, not a default left unexamined),
       and a reasoning-capable model (observed live with MiniMax-M3: ~290 completion tokens and
       ~8s just to say "OK") can spend real time and tokens before ever reaching the answer.
       Too low a cap or timeout truncates or aborts the response before any JSON exists at all. */
    maxTokens: 2500,
    timeoutMs: 20_000,
  });

  const raw = parseModelJson(response.text);
  if (raw === null) {
    throw new InterpretParseError(response.text);
  }

  return canonicaliseIntent(raw);
}
