/* Research endpoint — a grounded question-answering layer over the CaribEcon hub.

   The thesis, and the reason this exists at all: a frontier model asked a Caribbean macro
   question guesses. CariBench scored a bare model 0/5 and 1/5 even with web search, because
   the primary sources are PDFs, national statistics offices, and IMF releases that no crawler
   has usefully indexed. Given the hub as tools, the same model can answer from sourced records
   and say so — and, critically, say when the hub does NOT cover something instead of inventing
   a number. That refusal is the product, not a limitation of it.

   Unlike api/indicator.ts (deterministic, unauthenticated, cacheable), this endpoint spends
   tokens on every call, so it is authenticated and rate-limited. It is deliberately a separate
   function: a cold start here parses the editorial domains too, which the cheap lookup path
   must never do.

   The model never sees data it did not ask for. Every figure in an answer comes back through a
   tool result, and the citations returned to the client are recorded from what the tools
   actually served — not from what the model claims it read. */

/* Indicators only, deliberately — no news search in v1. Reaching the news archive means
   importing dataHub.ts, which is not nodenext-clean (extensionless specifiers, bare JSON
   imports) and so resolves under Astro's bundler but throws ERR_MODULE_NOT_FOUND in a
   deployed function — the exact production failure commit f9a654e fixed. Adding it back
   means first giving news the same lean, nodenext-safe split indicators.ts already has.
   No real loss here: headlines are context, never a source for a figure. */
import Anthropic from '@anthropic-ai/sdk';
import {
  getAllSeries,
  getCountries,
  getIndicatorMeta,
  getSeries,
  getIndicatorAllCountries,
} from '../src/lib/indicators.js';

const MODEL = process.env.RESEARCH_LLM_MODEL || 'claude-sonnet-5';
const MAX_TOKENS = 2000;
const MAX_TURNS = 8; // tool round-trips before we stop and answer with what we have
const MAX_QUESTION_CHARS = 500;

/* Best-effort, per-instance rate limiting. Fluid Compute reuses instances across requests so
   this does catch the common case, but it is a cost guard, not a security boundary — several
   instances each keep their own counter. The real ceilings are the token cap above and the
   shared secret below. */
const RATE_LIMIT = 12;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-CaribEcon-Token',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// ── System prompt ──────────────────────────────────────────────────────────────────────────

const SYSTEM = `You are the CaribEcon research assistant. You answer questions about Caribbean
macroeconomics using ONLY the CaribEcon data hub, reached through your tools.

The hub covers 19 Caribbean economies and 24 macro indicators, 2015-2025.

Rules, in priority order:

1. Never state a figure you did not receive from a tool result in this conversation. You have
   no reliable memory of Caribbean statistics; anything you recall unaided is a guess and a
   guess here is a failure, not a helpful approximation.
2. If the hub does not cover what was asked — a country, an indicator, a year, a breakdown —
   say so plainly and name what IS available instead. Reporting a gap is a correct answer.
   Coverage is genuinely uneven: several indicators exist for only 5 of the 19 economies.
3. Cite as you go, inline, in prose: the source organisation and the vintage, e.g.
   "(World Bank WDI, vintage 2026-07)". Do not append a bibliography; the client renders the
   full citations separately from what your tools actually returned.
4. Note the data type when it is not an actual: mark estimates and projections as such.
5. Units are country-specific for local-currency levels — never compare a GY$ figure with a
   TT$ one, and never sum across currencies. Percentages and ratios are comparable.
6. Do not compute anything the hub does not store beyond simple, clearly-labelled arithmetic
   on figures you have retrieved (a difference, a share, a growth rate between two retrieved
   values). Say what you did.
7. Be concise and specific — a research note, not an essay. A few short paragraphs at most.
   Lead with the answer.

Start by orienting yourself with list_countries or list_indicators if you are unsure of a slug
or of coverage, rather than guessing at a slug name.`;

// ── Tools ──────────────────────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_countries',
    description: 'The 19 economies in the hub, with their 2-letter codes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_indicators',
    description:
      'The 24 indicator slugs, with labels and how many economies carry each one. Use this to find the right slug and to check coverage before answering.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_series',
    description:
      'The full time series for one country and one indicator, with units and full provenance. The main tool — prefer it over guessing.',
    input_schema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: '2-letter code, e.g. "GY".' },
        indicator: { type: 'string', description: 'Indicator slug, e.g. "gdp_growth".' },
      },
      required: ['country', 'indicator'],
    },
  },
  {
    name: 'compare_countries',
    description:
      'One indicator across every economy that carries it, optionally at a single year. Use for rankings and regional comparisons.',
    input_schema: {
      type: 'object',
      properties: {
        indicator: { type: 'string', description: 'Indicator slug, e.g. "inflation".' },
        year: { type: 'number', description: 'Optional single year to compare at.' },
      },
      required: ['indicator'],
    },
  },
];

/* Provenance recorded from what the tools actually served. This — not the model's prose — is
   what the client displays as citations, so a citation can never be hallucinated. */
interface Citation {
  country: string;
  indicator: string;
  label: string;
  unit: string;
  source: string;
  sourceOrg: string;
  sourceTier: string;
  sourceUrl: string;
  vintage: string;
}

function citationFor(s: ReturnType<typeof getSeries>): Citation | null {
  if (!s) return null;
  const vintages = [...new Set(s.series.map(p => p.vintage))].sort();
  return {
    country: s.country,
    indicator: s.indicator,
    label: s.indicatorLabel,
    unit: s.unit,
    source: s.source,
    sourceOrg: s.sourceOrg,
    sourceTier: s.sourceTier,
    sourceUrl: s.sourceUrl,
    vintage: vintages[vintages.length - 1] ?? '',
  };
}

function runTool(name: string, input: Record<string, unknown>, cite: (c: Citation | null) => void) {
  switch (name) {
    case 'list_countries':
      return getCountries().map(c => ({ code: c.code, name: c.name }));

    case 'list_indicators': {
      const all = getAllSeries();
      return getIndicatorMeta().map(m => ({
        slug: m.slug,
        label: m.label,
        economies: all.filter(s => s.indicator === m.slug).map(s => s.country),
      }));
    }

    case 'get_series': {
      const country = String(input.country ?? '').toUpperCase();
      const indicator = String(input.indicator ?? '').toLowerCase();
      const s = getSeries(country, indicator);
      if (!s) {
        // An explicit miss with the available alternatives beats an empty result the model
        // might paper over.
        const forCountry = getAllSeries().filter(x => x.country === country).map(x => x.indicator);
        return {
          found: false,
          message: `The hub has no "${indicator}" series for ${country}.`,
          available_for_that_country: forCountry,
        };
      }
      cite(citationFor(s));
      return {
        found: true,
        country: s.country,
        indicator: s.indicator,
        label: s.indicatorLabel,
        unit: s.unit,
        source: s.source,
        sourceOrg: s.sourceOrg,
        sourceTier: s.sourceTier,
        note: s.seriesNote ?? null,
        points: s.series.map(p => ({ year: p.year, value: p.value, type: p.type, vintage: p.vintage })),
      };
    }

    case 'compare_countries': {
      const indicator = String(input.indicator ?? '').toLowerCase();
      const all = getIndicatorAllCountries(indicator);
      if (!all.length) {
        return { found: false, message: `No "${indicator}" series in the hub.` };
      }
      const year = typeof input.year === 'number' ? input.year : null;
      for (const s of all) cite(citationFor(s));
      return {
        found: true,
        indicator,
        label: all[0].indicatorLabel,
        economies: all.map(s => ({
          country: s.country,
          unit: s.unit,
          sourceOrg: s.sourceOrg,
          points: (year === null ? s.series : s.series.filter(p => p.year === year)).map(p => ({
            year: p.year,
            value: p.value,
            type: p.type,
          })),
        })),
      };
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    /* Fail closed. An unset token would otherwise leave a token-spending endpoint open to the
       world the moment it deploys, which is a worse failure than a clear 503. The add-in gets
       the token baked in at build time — that is obscurity rather than real authentication,
       and combined with the rate limit it is proportionate for a read-only research demo. */
    const expected = process.env.CARIBECON_RESEARCH_TOKEN;
    if (!expected) {
      return json(
        { error: 'not_configured', message: 'CARIBECON_RESEARCH_TOKEN is not set on the server.' },
        503,
      );
    }
    if (request.headers.get('X-CaribEcon-Token') !== expected) {
      return json({ error: 'unauthorized' }, 401);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return json({ error: 'not_configured', message: 'ANTHROPIC_API_KEY is not set.' }, 503);
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'rate_limited', message: 'Too many questions. Try again shortly.' }, 429);
    }

    let question: string;
    try {
      const body = (await request.json()) as { question?: unknown };
      question = String(body.question ?? '').trim();
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }
    if (!question) {
      return json({ error: 'bad_request', message: 'A "question" is required.' }, 400);
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return json(
        { error: 'bad_request', message: `Question must be under ${MAX_QUESTION_CHARS} characters.` },
        400,
      );
    }

    const client = new Anthropic();
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

    // Deduped by country+indicator so a series read twice is cited once.
    const cited = new Map<string, Citation>();
    const cite = (c: Citation | null) => {
      if (c) cited.set(`${c.country}|${c.indicator}`, c);
    };
    const toolsUsed: string[] = [];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM,
          tools: TOOLS,
          messages,
        }, { signal: request.signal });

        if (response.stop_reason !== 'tool_use') {
          const answer = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('\n')
            .trim();

          return json(
            {
              answer,
              citations: [...cited.values()],
              toolsUsed,
              model: MODEL,
              truncated: response.stop_reason === 'max_tokens',
            },
            200,
          );
        }

        messages.push({ role: 'assistant', content: response.content });
        messages.push({
          role: 'user',
          content: response.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
            .map(block => {
              toolsUsed.push(block.name);
              let result: unknown;
              try {
                result = runTool(block.name, block.input as Record<string, unknown>, cite);
              } catch (error) {
                // A thrown tool goes back to the model as a result, not as a 500 — it can
                // recover by asking for something else.
                result = { error: error instanceof Error ? error.message : 'tool failed' };
              }
              return {
                type: 'tool_result' as const,
                tool_use_id: block.id,
                content: JSON.stringify(result),
              };
            }),
        });
      }

      return json(
        {
          error: 'no_answer',
          message: `Gave up after ${MAX_TURNS} rounds of data lookups without reaching an answer.`,
          citations: [...cited.values()],
          toolsUsed,
        },
        504,
      );
    } catch (error) {
      if (request.signal.aborted) return json({ error: 'request_cancelled' }, 499);
      return json(
        { error: 'upstream', message: error instanceof Error ? error.message : 'Research failed.' },
        502,
      );
    }
  },
};
