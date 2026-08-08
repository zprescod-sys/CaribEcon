/* global fetch */

/* The loaded CaribEcon snapshot, shared by the custom functions and the task pane.

   Both need the same data and the same lookup rules; keeping them in one module is what stops
   the two from drifting apart. State lives on globalThis rather than in module scope because
   functions.js and taskpane.js are separate webpack entries — each gets its own copy of this
   module, so a plain module-level variable would mean two snapshots and two fetches. With the
   shared runtime declared in manifest.xml both copies run in one JS context, so parking state
   on a global genuinely shares it: the pane reuses whatever the functions already loaded.

   See api/snapshot.ts for the wire format. */

const STATE_KEY = '__caribeconHub';

function state() {
  let s = globalThis[STATE_KEY];
  if (!s) {
    s = globalThis[STATE_KEY] = { data: null, failed: false, promise: null };
  }
  return s;
}

/* Fetches the snapshot once per runtime. Repeat calls return the same promise, so the pane
   opening mid-flight joins the request the custom functions already started. Never rejects —
   callers check hubFailed() and fall back to per-lookup /api/indicator calls. */
export function loadHub(apiBase) {
  const s = state();
  if (s.promise) return s.promise;

  s.promise = fetch(`${apiBase}/api/snapshot`)
    .then(res => {
      if (!res.ok) throw new Error(`snapshot ${res.status}`);
      return res.json();
    })
    .then(raw => {
      const byKey = new Map();
      for (const series of raw.series) {
        byKey.set(`${series.c}|${series.i}`, series);
      }
      s.data = {
        version: raw.version,
        countries: raw.countries,
        indicators: raw.indicators,
        series: raw.series,
        byKey,
      };
      return s.data;
    })
    .catch(() => {
      s.failed = true;
      return null;
    });

  return s.promise;
}

export function hub() {
  return state().data;
}

export function hubFailed() {
  return state().failed;
}

// ── Wire point tuples: [year, value, type, vintage] ────────────────────────────────────────

export const P_YEAR = 0;
export const P_VALUE = 1;
export const P_TYPE = 2;
export const P_VINTAGE = 3;

// ── Argument normalisation ─────────────────────────────────────────────────────────────────
// Excel users type "gy" as readily as "GY", and the hub is keyed case-sensitively. Normalising
// in one place means a lowercase code is a hit rather than a mystifying #N/A.

export function normCountry(country) {
  return typeof country === 'string' ? country.trim().toUpperCase() : '';
}

export function normSlug(slug) {
  return typeof slug === 'string' ? slug.trim().toLowerCase() : '';
}

// ── Lookups (null when absent — callers decide how to surface a miss) ──────────────────────

export function findSeries(h, country, slug) {
  return h.byKey.get(`${country}|${slug}`) ?? null;
}

export function findPoint(h, country, slug, year) {
  const series = findSeries(h, country, slug);
  if (!series) return null;
  const point = series.p.find(p => p[P_YEAR] === year);
  if (!point || point[P_VALUE] === null) return null;
  return { series, point };
}

/* Sourced rows only: years whose value is null are dropped rather than returned as zero, which
   Excel would happily chart as a real observation. */
export function pointsInRange(series, from, to) {
  return series.p.filter(p => p[P_VALUE] !== null && p[P_YEAR] >= from && p[P_YEAR] <= to);
}

// ── Display helpers (task pane) ────────────────────────────────────────────────────────────

export function countryName(h, code) {
  return h.countries.find(c => c.code === code)?.name ?? code;
}

export function indicatorLabel(h, slug) {
  return h.indicators.find(i => i.slug === slug)?.label ?? slug;
}

// Which countries actually have a given indicator — coverage is uneven, and surfacing that
// beats letting someone discover it as an error.
export function countriesWith(h, slug) {
  return h.series.filter(s => s.i === slug).map(s => s.c);
}

// Which indicators a given country actually has.
export function indicatorsFor(h, code) {
  const have = new Set(h.series.filter(s => s.c === code).map(s => s.i));
  return h.indicators.filter(i => have.has(i.slug));
}
