/* Gate 1 read-only API — the one live endpoint behind CE.GDP / CE.GDPGROWTH / CE.INDICATOR.
   Deployed as a standalone Vercel Serverless Function (top-level /api), separate from the
   static Astro build, so the public site's output: 'static' stays untouched. Deterministic
   lookup only — no LLM calls belong here; that's the agent pipeline's job in later gates. */
import { getSeries } from '../src/lib/dataHub';

function json(body: unknown, status: number, cache = false): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // The hub only changes on deploy, so successful lookups are safe to cache at Vercel's
      // edge — shrinks the round-trip (and the Excel #BUSY! flash) on repeat calls, e.g. a
      // pre-warmed demo formula or a judge re-entering the same lookup.
      ...(cache ? { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400' } : {}),
    },
  });
}

export default {
  fetch(request: Request): Response {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
        },
      });
    }

    const url = new URL(request.url);
    const country = url.searchParams.get('country');
    const indicator = url.searchParams.get('indicator');
    const yearParam = url.searchParams.get('year');
    const year = yearParam ? Number(yearParam) : NaN;

    if (!country || !indicator || !Number.isInteger(year)) {
      return json(
        { error: 'bad_request', message: 'country, indicator, and year (integer) are required.' },
        400,
      );
    }

    const series = getSeries(country, indicator);
    const point = series?.series.find(p => p.year === year);

    if (!series || !point || point.value === null) {
      return json(
        { error: 'not_found', message: `No sourced value for ${country}/${indicator}/${year}.` },
        404,
      );
    }

    return json(
      {
        country,
        indicator,
        year,
        indicatorLabel: series.indicatorLabel,
        value: point.value,
        unit: series.unit,
        type: point.type,
        vintage: point.vintage,
        source: series.source,
        sourceOrg: series.sourceOrg,
        sourceTier: series.sourceTier,
        sourceUrl: series.sourceUrl,
        confidence: series.confidence,
      },
      200,
      true,
    );
  },
};
