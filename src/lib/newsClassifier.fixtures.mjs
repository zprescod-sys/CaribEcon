/* Regression fixtures for the LLM news classifier (src/lib/newsClassifierLLM.mjs) and its
 * rubric (src/lib/newsRubric.md). These are NOT run in `npm test` — asserting them requires
 * a live, billed Haiku call, so they're not automated CI assertions. They're the reference
 * table the `tune-news-rubric` workflow (docs/news-skills-scope.md) dry-runs against when
 * tuning the rubric, so a future edit can't silently regress a case that's already fixed.
 *
 * To dry-run: import classifyHeadlinesLLM, pass `items` through it, and diff the results
 * against `expected` for each fixture.
 */

export const NEWS_CLASSIFIER_FIXTURES = [
  // ── Polysemy — the exact failures a keyword filter can't make ──────────────────
  { title: 'strike gold for Guyana at CASA Juniors', source: 'Kaieteur News', country: 'GY',
    expected: { decision: 'drop' } },
  { title: 'Omai gold project to lift output to 750,000 ounces', source: 'Kaieteur News', country: 'GY',
    expected: { decision: 'publish', category: 'Energy' } },
  { title: 'The Extravagant Mind: your attention is currency', source: 'Kaieteur News', country: 'GY',
    expected: { decision: 'drop' } },
  { title: 'Revellers celebrate Crop Over', source: 'Barbados Today', country: 'BB',
    expected: { decision: 'drop' } },
  { title: 'Rice crop output rebounds to 200,000 tonnes', source: 'Kaieteur News', country: 'GY',
    expected: { decision: 'publish', category: 'Agriculture' } },
  { title: 'IShowSpeed and Tom Cruise join World Cup closing ceremony', source: 'Reuters', country: 'ALL',
    expected: { decision: 'drop' } },

  // ── Deal status — a completed transaction vs. a proposal vs. no transaction ────
  { title: 'Petronas eyes final investment decision in Suriname after 8 discoveries totalling over 1 billion barrels',
    source: 'Kaieteur News', country: 'SR',
    expected: { decision: 'publish', category: 'Energy', deal_status: 'pending', deal_type: 'FDI' } },
  { title: 'Dolla Financial completes acquisition of Evolve loan portfolio',
    source: 'Jamaica Observer', country: 'JM',
    expected: { decision: 'publish', category: 'Banking', deal_status: 'completed', deal_type: 'M&A' } },
  { title: 'St Lucian company to buy majority stake in Dolphin Cove',
    source: 'Jamaica Gleaner', country: 'JM',
    expected: { decision: 'publish', category: 'Investment', deal_status: 'pending', deal_type: 'M&A' } },

  // ── Added 2026-07-24 — real over-inclusion found in the first live production run ──
  { title: 'Transparency Institute wants International Maritime Organisation to investigate MV Barima tragedy',
    source: 'Kaieteur News', country: 'GY',
    // Was wrongly `publish/Government` — a bare accident-investigation call with no stated
    // economic mechanism. See newsRubric.md's "Accident/tragedy" bullet under What is NOT relevant.
    expected: { decision: 'review', deal_status: 'not_a_deal' } },
  { title: 'Reyme slaat alarm over vervuiling Marowijnerivier',
    source: 'Starnieuws', country: 'SR',
    // Was wrongly `publish/Climate` — an environmental alarm with no stated economic impact.
    expected: { decision: 'drop', deal_status: 'not_a_deal' } },
  { title: 'Sunrise Airways launches new Antigua-Barbados route',
    source: 'Antigua Observer', country: 'AG',
    // Was wrongly staged as `completed/FDI` — a new route is operational news, not a deal.
    // The news decision itself was already correct (publish); only deal_status was wrong.
    expected: { decision: 'publish', category: 'Tourism', deal_status: 'not_a_deal', deal_type: null } },
];
