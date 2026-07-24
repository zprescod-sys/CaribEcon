/* LLM news classifier — Claude Haiku 4.5 judges publish|review|drop, category, and Deals &
 * Investment status for a batch of new headlines in one structured-output API call. Runs
 * server-side only, at ingest inside the GitHub Action (scripts/build-feeds.mjs) — the key
 * is read from ANTHROPIC_API_KEY and this module is never imported by client/page code, so
 * it never reaches the browser. See docs/news-llm-classifier-plan.md for the full
 * architecture and src/lib/newsRubric.md for the editorial policy sent as the system prompt.
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NEWS_CATEGORY_GROUPS } from './newsRelevance.mjs';

// import.meta.url, not __dirname — __dirname doesn't exist in ES modules.
const __dirname = dirname(fileURLToPath(import.meta.url));
const RUBRIC = readFileSync(join(__dirname, 'newsRubric.md'), 'utf8');

// NEWS_LLM_MODEL lets an operator override the model without touching code (see the plan doc's
// env-knobs section); defaults to the model this whole classifier was designed and cost-priced
// around.
const DEFAULT_MODEL = process.env.NEWS_LLM_MODEL || 'claude-haiku-4-5';

// Chunking keeps every single API call's max_tokens comfortably under the ~16K threshold where
// the Anthropic SDK requires streaming to avoid HTTP timeouts (see docs/news-llm-classifier-plan.md).
// Typical daily volume (~50-100 new headlines across two feed runs) is one chunk; this only
// matters for a rare backlog catch-up run with far more new items than usual.
const CHUNK_SIZE = 100;
const TOKENS_PER_ITEM = 100;
const TOKENS_BUFFER = 500;

const DEAL_TYPES = ['M&A', 'FDI', 'Bond', 'IPO', 'JV', 'Concession', 'Other'];

// The category enum is built from NEWS_CATEGORY_GROUPS' own keys, not hand-copied from the
// rubric text — so the model is mechanically incapable of returning a category this codebase
// doesn't know how to map to a filter-bar group. This is the anti-drift guarantee the plan
// calls for: the heuristic fallback and the LLM classifier share one category vocabulary.
const VALID_CATEGORIES = Object.keys(NEWS_CATEGORY_GROUPS);

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          decision: { type: 'string', enum: ['publish', 'review', 'drop'] },
          category: {
            anyOf: [{ type: 'string', enum: VALID_CATEGORIES }, { type: 'null' }],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reason: { type: 'string' },
          deal_status: { type: 'string', enum: ['completed', 'pending', 'not_a_deal'] },
          deal_type: {
            anyOf: [{ type: 'string', enum: DEAL_TYPES }, { type: 'null' }],
          },
        },
        required: ['id', 'decision', 'category', 'confidence', 'reason', 'deal_status', 'deal_type'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

/**
 * Classify one chunk (<= CHUNK_SIZE items) in a single API call.
 * @param {Array<{id: string, title: string, source: string, country?: string|string[], tags?: string[]}>} chunk
 * @param {string} model
 */
async function classifyChunk(chunk, model) {
  const client = new Anthropic();
  const maxTokens = Math.min(64000, chunk.length * TOKENS_PER_ITEM + TOKENS_BUFFER);

  // Only id/title/source/country/tags are ever sent — never article bodies (the plan's
  // body-free policy). No `thinking` and no `output_config.effort`: effort isn't a supported
  // parameter on Haiku 4.5 and returns a 400 if set.
  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: RUBRIC,
    output_config: { format: { type: 'json_schema', schema: RESULT_SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Classify each of these ${chunk.length} headlines per your instructions. ` +
          `Return exactly one result per "id".\n\n` +
          JSON.stringify(
            chunk.map(({ id, title, source, country, tags }) => ({
              id,
              title,
              source,
              country: country ?? null,
              tags: tags ?? [],
            })),
          ),
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) throw new Error('classifyHeadlinesLLM: no text content in the response');
  const { results } = JSON.parse(textBlock.text);

  const byId = new Map(results.map((result) => [result.id, result]));
  return chunk.map(({ id }) => {
    const result = byId.get(id);
    if (!result) throw new Error(`classifyHeadlinesLLM: model returned no result for id "${id}"`);
    return {
      id,
      decision: result.decision,
      category: result.category,
      group: result.category ? (NEWS_CATEGORY_GROUPS[result.category] ?? null) : null,
      confidence: result.confidence,
      reason: result.reason,
      deal_status: result.deal_status,
      deal_type: result.deal_type,
    };
  });
}

/**
 * Classify new headlines with Claude Haiku 4.5, chunking large batches so a single call never
 * needs to stream. Throws on any failure (bad key, API down, malformed response) so the caller
 * (scripts/build-feeds.mjs) can fall back to the heuristic — this function never partially
 * succeeds and silently drops items.
 * @param {Array<{id: string, title: string, source: string, country?: string|string[], tags?: string[]}>} items
 * @param {{model?: string}} [options]
 * @returns {Promise<Array<{
 *   id: string,
 *   decision: 'publish'|'review'|'drop',
 *   category: string|null,
 *   group: string|null,
 *   confidence: 'high'|'medium'|'low',
 *   reason: string,
 *   deal_status: 'completed'|'pending'|'not_a_deal',
 *   deal_type: string|null,
 * }>>}
 */
export async function classifyHeadlinesLLM(items, { model = DEFAULT_MODEL } = {}) {
  if (items.length === 0) return [];

  const results = [];
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE);
    results.push(...(await classifyChunk(chunk, model)));
  }
  return results;
}
