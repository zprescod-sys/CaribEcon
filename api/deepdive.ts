/* Single Country Deep Dive — deterministic core (plan §6, Phase 2a).

   Retrieval + compute + plan, steps 1/3 of the tightened pipeline (step 1's Interpreter is the
   task pane's explicit picker for now — no natural-language path exists yet). Step 6,
   Delivery, is deliberately NOT here: writing tables/charts into the sheet needs the Office.js
   API, which only runs in the task pane, not a serverless function. This endpoint returns
   structured JSON — including a fully-computed WorkbookPlan — and the task pane executes it
   verbatim rather than deciding layout itself.

   Same nodenext-safe convention as api/indicator.ts: explicit .js specifiers, imports
   askTools.ts (which imports indicators.ts, never dataHub.ts) so a cold start never parses the
   editorial domains for a plain data lookup. Unauthenticated and CORS-open like
   api/indicator.ts/api/snapshot.ts — this spends no tokens, unlike api/ask.ts. */
import { getSeriesEvidence, type RetrievalMiss } from '../src/lib/askTools.js';
import { validateSingleCountryPicker } from '../src/lib/excelIntent.js';
import { yoy_change, pp_change, period_average } from '../src/lib/calculations.js';
import {
  buildChartSpecification,
  buildWorkbookPlan,
  calculationForUnit,
  type ChartSpec,
  type IndicatorResult,
} from '../src/lib/excelOutputs.js';

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

interface RequestBody {
  country?: unknown;
  indicators?: unknown;
  yearFrom?: unknown;
  yearTo?: unknown;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function toYearOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const year = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(year) ? year : null;
}

/* The wire shape per indicator: excelOutputs.ts's IndicatorResult (evidence, periodAverage,
   change) is exactly what buildWorkbookPlan consumes, plus a per-indicator chartSpec so the task
   pane can render a preview before any insertion happens — the full WorkbookPlan below carries
   its own chart placements for the actual write. */
type ResponseIndicatorResult = IndicatorResult & { chartSpec: ChartSpec | null };

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      });
    }

    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let body: RequestBody;
    try {
      body = (await request.json()) as RequestBody;
    } catch {
      return json({ error: 'bad_request', message: 'Body must be JSON.' }, 400);
    }

    const { intent, misses: intentMisses } = validateSingleCountryPicker({
      countries: typeof body.country === 'string' ? [body.country] : [],
      indicators: toStringArray(body.indicators),
      yearFrom: toYearOrNull(body.yearFrom),
      yearTo: toYearOrNull(body.yearTo),
    });

    if (!intent) {
      return json({ error: 'bad_request', misses: intentMisses }, 400);
    }

    const indicators: Record<string, ResponseIndicatorResult> = {};
    const misses: RetrievalMiss[] = [...intentMisses];

    for (const slug of intent.indicators) {
      const { evidence, miss } = getSeriesEvidence(intent.country, slug, intent.yearFrom, intent.yearTo);
      if (miss) {
        misses.push(miss);
        continue;
      }
      // getSeriesEvidence only returns null evidence alongside a miss (see askTools.ts), so
      // evidence is non-null here — but the type is still `| null`, so make that explicit
      // rather than asserting past the compiler.
      if (!evidence) continue;

      // A series that is already a rate (unit "%") takes percentage-POINT change; everything
      // else takes relative percentage change. See pp_change's header in calculations.ts —
      // running yoy_change on a rate computes "% change of a %", which misleads.
      const changeName = calculationForUnit(evidence.unit);
      const change = {
        name: changeName,
        results: (changeName === 'pp_change' ? pp_change : yoy_change)(evidence.points),
      };

      indicators[slug] = {
        evidence,
        periodAverage: period_average(evidence.points),
        change,
        chartSpec: buildChartSpecification([evidence], intent),
      };
    }

    const workbookPlan = buildWorkbookPlan(Object.values(indicators), intent, misses);

    return json({ intent, indicators, misses, workbookPlan }, 200);
  },
};
