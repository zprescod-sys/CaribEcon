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
import type { ConversationTurn, ResearchIntent } from '../contracts.js';

export class InterpretNotConfiguredError extends Error {}

/* Distinct from a RetrievalMiss on purpose: a miss means "the model named something real
   evidence doesn't cover," which canonicaliseIntent already reports faithfully. This means "the
   model's output could not even be read as an intent" — a failure of the interpret step itself,
   not a fact about hub coverage. Folding it into misses (as an empty intent with no misses,
   which is what canonicaliseIntent(null) alone would silently produce) would let a total
   interpretation failure look identical to "an in-scope, well-formed question." */
export class InterpretParseError extends Error {
  constructor(
    public readonly rawText: string,
    // Diagnostic pair carried by all three role parse errors — see api/ask.ts's
    // structuredOutputFailure() for what they distinguish and why it matters.
    public readonly finishReason: string | null = null,
    public readonly completionTokens: number | null = null,
  ) {
    super('The model did not return parseable JSON for intent extraction.');
  }
}

export interface InterpretResult {
  intent: ResearchIntent;
  misses: RetrievalMiss[];
}

/* Oldest-first (ResearchRequest.history's own documented order). Each turn is rendered as its
 * question, the refs its answer actually rested on (a D:/N: ref already encodes country+indicator
 * — "D:TT:oil_exports" — so this alone carries most of what a follow-up needs to resolve "their"
 * or "that"), and the headline as a compact summary of what was concluded. Never the full
 * claims[] — see ConversationTurn's own doc comment (contracts.ts) for why headline-only is what
 * "compact" means here. */
function describeHistory(history: ConversationTurn[]): string[] {
  return history.map(
    (turn, i) =>
      `${i + 1}. Q: "${turn.question}" — refs: ${turn.refs.length ? turn.refs.join(', ') : '(none)'} — answered: "${turn.headline}"`,
  );
}

function buildSystemPrompt(history: ConversationTurn[]): string {
  const countries = listCountries()
    .map(c => `${c.code}=${c.name}`)
    .join(', ');
  const indicators = listIndicators()
    .map(i => `${i.slug}=${i.label}`)
    .join(', ');

  const sections = [
    'You turn a question about Caribbean macroeconomics into structured JSON so a deterministic',
    'retrieval layer can look up real data. You never answer the question yourself, and naming a',
    'country or indicator that is not in the lists below is fine — it will be reported as',
    'unavailable rather than guessed, so do not avoid a name just because you are unsure of it.',
  ];

  if (history.length) {
    sections.push(
      '',
      'RECENT CONVERSATION (oldest first) — use this ONLY to resolve a pronoun or omission in the',
      'new question below ("their", "that country", "now", "what about exports instead"). The new',
      'question is authoritative: if it already names its own country or indicator, IGNORE the',
      'conversation below entirely rather than blend the two — never let an earlier topic leak',
      'into a question that did not ask about it.',
      ...describeHistory(history),
    );
  }

  sections.push(
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
  );

  return sections.join('\n');
}

export async function interpret(question: string, history: ConversationTurn[] = []): Promise<InterpretResult> {
  const resolved = resolveRoleFully('interpret');
  if (!resolved) {
    throw new InterpretNotConfiguredError(
      'CARIBECON_INTERPRET_PROVIDER/_MODEL and that provider\'s connection must be configured.',
    );
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(history) },
    { role: 'user', content: question },
  ];

  const response = await callModel(resolved.connection, resolved.model, messages, {
    temperature: 0,
    /* ── The canonical maxTokens rationale for every JSON role; plan.ts and synthesize.ts refer
       back here rather than repeat it. ──
       maxTokens is a RUNAWAY BACKSTOP, not an estimate of the answer's size. It is set high
       enough that a normal call never reaches it, so timeoutMs is the single binding constraint
       and a `finish_reason: "length"` in the logs is a genuine alarm rather than routine noise.
       Thinking stays ON deliberately (the project's own choice, not a default left unexamined),
       and a reasoning-capable model (observed live with MiniMax-M3: ~290 completion tokens and
       ~8s just to say "OK") spends real tokens before reaching the answer.
       Why generous rather than tuned: truncation here is a CLIFF, not a gradient. stripThinking()
       (openaiCompatible.ts) deliberately leaves an unterminated <think> block intact, so a call cut
       off mid-reasoning yields NO parseable JSON at all — not a shorter answer. Overshooting the
       cap costs nothing (providers bill per token actually generated, and a call needing 1500
       tokens finishes just as fast at an 8000 cap as at a 2000 one — measured in newsExtract.ts's
       own sweep); undershooting costs the entire response and returns a 502.
       8000 is that file's measured-safe floor, adopted here to replace an unmeasured 2500 that was
       only ever labelled a "starting point".
       timeoutMs is deliberately NOT raised anywhere: vercel.json caps api/ask.ts at maxDuration
       240s, and interpret+plan+newsExtract+synthesize already sum to 185s of worst-case wall clock
       before any Tavily time. Wall clock is the scarce budget here; tokens are not. */
    maxTokens: 8_000,
    timeoutMs: 20_000,
  });

  const raw = parseModelJson(response.text);
  if (raw === null) {
    throw new InterpretParseError(response.text, response.finishReason, response.usage?.completionTokens ?? null);
  }

  return canonicaliseIntent(raw);
}
