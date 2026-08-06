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

  // ── Added 2026-07-25 — deal_status misses found in a live warrenb triage run:
  // pending transactions (LOI, "proposed" issuance) mis-staged as `completed`. See
  // newsRubric.md § "Deal status" — "prospective verbs" and "a qualifier that labels the
  // transaction controls" paragraphs added to fix this class of case.
  { title: 'New Canadian firm moves to acquire 64 km² of mineral claims in US$1.1M deal from local owner',
    source: 'Kaieteur News', country: 'GY',
    // "moves to acquire" — a real step (an LOI), not a closed deal. Source itself states
    // "no assurance the acquisition will be completed" (due diligence/regulatory pending).
    // deal_type not asserted: M&A (asset purchase) vs FDI (new foreign capital into a
    // resource project) is a genuinely defensible either-way call here, not a correctness bug.
    expected: { decision: 'publish', deal_status: 'pending' } },
  { title: 'Government exempts proposed US$800m bond issue from taxes, exchange control',
    source: 'CNC3', country: 'TT',
    // The exemption is a done government action, but "proposed" labels the bond issue
    // itself as not yet closed — the deal status tracks the bond, not the exemption.
    expected: { decision: 'publish', deal_status: 'pending', deal_type: 'Bond' } },

  // ── Added 2026-07-27 — development-finance lending was invisible to the Deals page.
  // "IDB Invest approves US$500m financing for ANSA McAL" (2026-07-22, Trinidad Express) sat in
  // news.json without ever reaching Deals: the rubric's `pending` bullet swept up "regulatory
  // approval stage / non-operational financing stage", and DealType had no slot for a credit
  // facility. Fixed by the `Debt` type + newsRubric.md § "whose approval closes the deal".
  { title: 'IDB Invest approves US$500m financing  for ANSA McAL',
    source: 'Trinidad Express', country: 'TT',
    // The lender approving its own facility IS the closing — not a third party clearing
    // someone else's deal. Contrast the "proposed US$800m bond issue" fixture above.
    expected: { decision: 'publish', deal_status: 'completed', deal_type: 'Debt' } },
  { title: 'ANSA McAL secures US$500M financing partnership with IDB Invest',
    source: 'CNC3', country: 'TT',
    // Same facility from the borrower's side. "secures" is a completed verb.
    expected: { decision: 'publish', deal_status: 'completed', deal_type: 'Debt' } },
  { title: 'CDB approves US$2m grant for school rehabilitation in Dominica',
    source: 'Dominica News Online', country: 'DM',
    // The guard on the widened lending rule: a grant is never repaid and buys no stake, so
    // capital moves but not for ownership or return. Must NOT become a Debt deal.
    expected: { deal_status: 'not_a_deal', deal_type: null } },

  // ── Added 2026-07-24 — real over-inclusion found in the first live production run ──
  { title: 'Transparency Institute wants International Maritime Organisation to investigate MV Barima tragedy',
    source: 'Kaieteur News', country: 'GY',
    // Was wrongly `publish/Government`, then wrongly `review` (see 2026-08-04 note below) — a
    // bare accident-investigation call with no economic mechanism at all belongs in `drop`.
    expected: { decision: 'drop', deal_status: 'not_a_deal' } },

  // ── Added 2026-08-04 — triage-review-inbox (`ian`) cleared 57 near-identical MV Barima
  // "accountability process" headlines in one run (COI swearing-in, protests, memorial/relief
  // gestures, court-process narration, blame commentary) — all correctly routed to `review` by
  // the classifier's own reasoning ("no stated economic mechanism"), then rejected 57/57 by the
  // human editor. That's not genuine ambiguity, it's an under-confident `review` on a shape the
  // classifier already recognizes as economically empty — recalibrated to `drop`. See
  // newsRubric.md's "Accident/disaster accountability process" bullet. These two are negative
  // controls proving the recalibration doesn't swallow the genuine economic-mechanism cases:
  { title: 'President Ali urges full truth as members of MV Barima tragedy CoI sworn in',
    source: 'Guyana Chronicle', country: 'GY',
    // Same shape as the fixture above — inquiry ceremony, no economic mechanism.
    expected: { decision: 'drop', deal_status: 'not_a_deal' } },
  { title: 'APNU questions safety of sunken MV Barima amidst tender documents for sweeping rehabilitation',
    source: 'Kaieteur News', country: 'GY',
    // Must NOT collapse into the drop pattern above: this one references an actual
    // rehabilitation tender, a plausible-but-unconfirmed mechanism — stays `review`.
    expected: { decision: 'review' } },
  { title: 'MV Barima salvage too urgent for lengthy tender process – Mahipaul urges Govt. to invoke emergency procurement powers',
    source: 'Kaieteur News', country: 'GY',
    // Must NOT collapse into the drop pattern either: emergency procurement powers is a
    // confirmed fiscal/regulatory mechanism — already correctly `publish` on the live site.
    expected: { decision: 'publish', category: 'Infrastructure', deal_status: 'not_a_deal' } },
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
