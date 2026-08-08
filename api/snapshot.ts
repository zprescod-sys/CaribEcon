/* Bulk indicator snapshot — the whole hub in one response, for clients that would otherwise
   fetch it one number at a time.

   Why this exists: Excel shows #BUSY! in a cell for exactly as long as a custom function's
   returned Promise is pending. With a per-cell /api/indicator call that meant a ~300ms flash on
   every entry, every fill-down, every recalc and every workbook reopen — 200 round-trips for a
   20x10 grid. The entire dataset is 2,742 points across 284 series and compresses to ~18KB, so
   the add-in fetches it once at runtime start and every formula becomes a synchronous in-memory
   lookup. See excel-addin/src/functions/functions.js.

   /api/indicator is unchanged and stays the public single-lookup API — it's also this endpoint's
   fallback path if the snapshot fetch ever fails.

   Imports ./indicators, not ./dataHub, for the same cold-start reason documented in
   api/indicator.ts: dataHub pulls news/publications/deals/budgets in at module scope. */
import { getAllSeries, getCountries, getIndicatorMeta } from '../src/lib/indicators.js';

/* Compact wire format. Keys are short because they repeat 284 and 2,742 times respectively;
   points are positional tuples rather than objects for the same reason. Provenance is kept in
   full — a number without its source is not something this project ships. */
type WirePoint = [year: number, value: number | null, type: string, vintage: string];

interface WireSeries {
  c: string;            // country code
  i: string;            // indicator slug
  u: string;            // unit — varies by country for local-currency slugs, so it lives here
  src: string;
  org: string;
  tier: string;
  url: string;
  conf: string;
  note?: string;        // seriesNote: source-divergence caveat, when present
  p: WirePoint[];
}

/* Built once per cold start and reused by every warm invocation — the payload only changes
   on deploy, so there is nothing to recompute per request. */
const payload = (() => {
  const series = getAllSeries();

  const wire: WireSeries[] = series.map(s => ({
    c: s.country,
    i: s.indicator,
    u: s.unit,
    src: s.source,
    org: s.sourceOrg,
    tier: s.sourceTier,
    url: s.sourceUrl,
    conf: s.confidence,
    ...(s.seriesNote ? { note: s.seriesNote } : {}),
    p: s.series.map(p => [p.year, p.value, p.type, p.vintage] as WirePoint),
  }));

  // Cheap, deterministic revalidation token: newest vintage in the hub + record count.
  // Changes whenever data is refreshed or a series is added; stable otherwise.
  let maxVintage = '';
  for (const s of series) {
    for (const p of s.series) {
      if (p.vintage > maxVintage) maxVintage = p.vintage;
    }
  }

  return JSON.stringify({
    version: `${maxVintage}:${series.length}`,
    countries: getCountries(),
    // Label is uniform per slug (unit is not), so it's deduped here rather than on every series.
    indicators: getIndicatorMeta().map(m => ({
      slug: m.slug,
      label: m.label,
      chartGroup: m.chartGroup,
      order: m.order,
    })),
    series: wire,
  });
})();

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

    return new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        // Same policy as api/indicator.ts: the hub only changes on deploy.
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
      },
    });
  },
};
