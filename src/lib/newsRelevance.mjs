/* News relevance + classification — the single source of truth for deciding whether a
 * headline belongs on an economic research platform, and which macro category it is.
 *
 * Used in BOTH places so the rule can never drift:
 *   - build time  → scripts/build-feeds.mjs (filters the RSS archive on ingest)
 *   - render time → src/lib/dataHub.ts (re-filters whatever is stored, so a messy or
 *                   stale headline can never reach the page even if it slipped past ingest)
 *
 * Policy: PRECISION OVER VOLUME. Better to drop a borderline story than to show a
 * sports/crime/lifestyle headline that undermines the platform's credibility.
 *
 * The decision, in plain English:
 *   1. No economic keyword at all            → DROP (not our beat).
 *   2. Economic keyword, no exclusion signal → KEEP.
 *   3. Economic keyword + exclusion signal   → KEEP only if a STRONG, unambiguous
 *      economic term is also present (e.g. a court ruling about "taxation"); else DROP.
 */

// ── Normalisation ─────────────────────────────────────────────────────────────
// Lowercase and strip accents so "Añasco" / "GRA" / "T&T" all match predictably.
function norm(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// Build a word-boundary-anchored alternation from a token list.
const re = (tokens) => new RegExp('\\b(?:' + tokens.join('|') + ')', 'i');

// ── Include: economic relevance (broad — recall) ──────────────────────────────
// Lookaheads defuse the worst stem false-positives: import(?!ant), tax(?!i),
// invest(?!igat). Whole-word forms (\bports?\b) avoid "portfolio"/"important".
const INCLUDE_RE = re([
  'econom\\w*', 'financ\\w*', 'fiscal', 'monetar\\w*', 'inflation', 'deflation', 'disinflation',
  'budget\\w*', 'deficit', 'surplus\\w*', 'debt', 'gdp', 'imf', 'eclac', 'unctad', 'oecd', 'idb\\b', 'cdb\\b',
  'tax(?!i)\\w*', 'tariff\\w*', 'trade\\w*', 'export\\w*', 'import(?!ant)\\w*', 'customs', '\\bfares?\\b',
  'invest(?!igat)\\w*', 'fdi', 'allocation\\w*',
  // gas(?!t) matches Dutch compounds ("gasvondst") without hitting the name "Gaston".
  'oil', 'gas(?!t)\\w*', 'olie\\w*', 'petronas', 'gasoline', 'petroleum', 'energy', 'lng', 'refiner\\w*', 'crude', 'barrel\\w*',
  'electricity', 'renewable\\w*', 'utilit\\w*',
  'tourism', 'tourist\\w*', 'hotel\\w*', 'resort\\w*', 'cruise\\w*', 'airline\\w*',
  'currenc\\w*', 'devalu\\w*', 'forex', 'revenue', 'expenditure', 'remittance\\w*', 'reserves?',
  'fintech', 'bank\\w*', 'loan\\w*', 'lending', 'credit', 'bond\\w*', 'treasur\\w*', 'mortgage\\w*',
  'market\\w*', 'stock\\w*', 'shareholder\\w*', 'equit\\w*', 'ipo', 'dividend\\w*', 'earnings', 'profit\\w*', 'turnover',
  'business\\w*', 'commerc\\w*', 'corporate', 'compan(?:y|ies)', 'enterprise\\w*',
  'manufactur\\w*', 'industr\\w*', 'factory', 'production',
  'agricultur\\w*', 'farm\\w*', 'crop\\w*', 'commodit\\w*', 'sugar', 'banana\\w*', 'rice', 'cocoa', 'coffee', '\\brum\\b',
  'mining', 'bauxite', 'gold\\b', 'quarr\\w*',
  'shipping', 'ports?\\b', 'seaports?', 'airports?', 'harbour\\w*', 'logistic\\w*', 'cargo', 'freight', 'vessel\\w*', 'bridge\\w*',
  'employ\\w*', 'unemploy\\w*', 'jobs?\\b', 'labou?r\\w*', 'wage\\w*', 'salar\\w*', 'workforce', 'layoffs?', 'redundanc\\w*',
  'pension\\w*', 'recession', 'growth', 'productiv\\w*', 'subsid\\w*', 'price\\w*',
  'default\\w*', 'restructur\\w*', 'ratings?\\b', 'procurement', 'tenders?\\b',
  'merger\\w*', 'acquisition\\w*', 'acquir\\w*', 'takeover', 'buyout', 'divest\\w*', 'privatiz\\w*', 'concession\\w*',
  'infrastructure', 'construction', 'housing',
]);
const INCLUDE_PHRASES = [
  'world bank', 'central bank', 'interest rate', 'exchange rate', 'cost of living', 'credit rating',
  'real estate', 'private sector', 'public sector', 'gross domestic', 'balance of payments',
  'current account', 'foreign exchange', 'development bank', 'stake in', 'joint venture', 'free trade',
  'doing business', 'sovereign wealth', 'natural resource fund', 'per capita', 'ease of doing',
];

// ── Strong: unambiguous economics (overrides a single exclusion signal) ───────
// Deliberately narrow. Bare "debt"/"bond"/"oil"/"business" are NOT strong — they co-occur
// too easily with crime/sport (bail bond, oil-firm football sponsorship). Only terms that
// are almost always genuine macro/finance qualify to rescue an otherwise-excluded headline.
const STRONG_RE = re([
  'gdp', 'inflation', 'deflation', 'fiscal', 'monetar\\w*', 'budget\\w*', 'deficit', 'surplus\\w*',
  'tariff\\w*', 'imf', 'eclac', 'unctad', 'idb\\b', 'cdb\\b', 'fdi', 'sovereign\\w*', 'eurobond\\w*', 'taxation',
  'tax(?!i)\\w*', 'revenue', 'expenditure', 'remittance\\w*', 'privatiz\\w*', 'devalu\\w*', 'recession',
]);
const STRONG_PHRASES = [
  'world bank', 'central bank', 'interest rate', 'exchange rate', 'cost of living', 'credit rating',
  'balance of payments', 'current account', 'foreign exchange', 'bond issue', 'sovereign debt',
  'public debt', 'national debt', 'debt restructur', 'trade deficit', 'fiscal deficit',
  'export earnings', 'oil production', 'gas production', 'oil rig', 'gas field', 'refinery',
  'economic growth', 'per capita',
];

// ── Exclude: off-topic signals (sport / crime / entertainment / lifestyle) ────
// Terms too ambiguous to filter safely are intentionally omitted: "fire" (layoffs/fire-sale),
// "crash" (market crash), "goal"/"final" (policy goals, final budget), "match" (matched funds).
const EXCLUDE_RE = re([
  // sport
  'football\\w*', 'cricket\\w*', 'netball\\w*', 'basketball', 'volleyball', 'rugby', 'athletic\\w*',
  'sprint\\w*', 'olympic\\w*', 'commonwealth games', 'tournament\\w*', 'championship\\w*', '\\bleague\\b',
  'playoffs?', 'semifinal\\w*', 'quarterfinal\\w*', 'fixtures?\\b', 'strikers?\\b', 'midfielder\\w*',
  'batsm(?:a|e)n', 'bowler\\w*', 'wicket\\w*', 'innings', 'goalkeeper', 'coach\\w*', 'squad', 'medal\\w*',
  'marathon', 'regatta', 'cyclist\\w*', 'boxing', 'boxer\\b', 'footballers?', 'netballers?', 'windies',
  // crime / court / police
  'murder\\w*', 'homicide', 'manslaughter', 'killed\\b', 'shot\\b', 'shooting\\w*', 'gunm(?:a|e)n',
  'gunshot\\w*', 'stabb\\w*', 'wounded', 'rape[ds]?\\b', 'rapist', 'molest\\w*', 'assault\\w*', 'kidnap\\w*',
  'ransom', 'robber\\w*', 'robbed', 'burglar\\w*', 'theft\\b', 'thief\\b', 'stolen', 'arrest\\w*',
  'charged\\b', 'remand\\w*', 'bail\\b', 'accused', 'suspect\\w*', 'convict\\w*', 'sentenced', 'jailed',
  'prison\\w*', 'court\\b', 'magistrate', 'police\\b', 'cocaine', 'marijuana', 'ganja', 'cannabis',
  'traffick\\w*', 'smuggl\\w*', 'gang\\b', 'shootout', 'machete', 'accident\\w*', 'injured',
  // entertainment / culture
  'carnival', 'calypso\\w*', 'soca\\b', 'dancehall', 'reggae', 'concert\\w*', 'festival\\w*', 'pageant\\w*',
  'beauty queen', 'miss universe', 'fashion', 'movie\\w*', 'film\\w*', 'actor\\b', 'actress', 'singer\\w*',
  'album\\b', 'mixtape', 'celebrit\\w*', 'music\\b',
  // human-interest / community / lifestyle
  'obituar\\w*', 'funeral\\w*', 'wedding\\w*', 'birthday\\w*', 'graduat\\w*', 'valedictorian',
  'scholarship\\w*', 'school\\w*', 'student\\w*', 'church\\w*', 'pastor', 'bishop', 'congregation',
  'recipe\\w*', 'cooking\\b', 'lifestyle', 'horoscope', 'zodiac', 'heartwarming', 'gofundme', 'puppy',
]);

/**
 * True if a headline belongs on the platform.
 * @param {string} title
 * @param {string[]} [tags]
 */
export function isRelevantNews(title, tags = []) {
  const hay = norm(`${title} ${(tags ?? []).join(' ')}`);
  const included = INCLUDE_RE.test(hay) || INCLUDE_PHRASES.some(p => hay.includes(p));
  if (!included) return false;                                   // rule 1
  if (!EXCLUDE_RE.test(hay)) return true;                        // rule 2
  return STRONG_RE.test(hay) || STRONG_PHRASES.some(p => hay.includes(p)); // rule 3
}

// ── Classification: which macro category, for the card tag + filter bar ───────
// Each rule maps to a display `category` (the chip on the card) and a `group` (the
// coarse bucket the News filter bar toggles). First match wins, so order = priority.
const RULES = [
  { category: 'Energy',         group: 'Energy',           re: re(['oil', 'gas(?!t)\\w*', 'olie\\w*', 'petronas', 'lng', 'petroleum', 'crude', 'refiner\\w*', 'barrel\\w*', 'energy', 'electricity', 'renewable\\w*', 'solar', 'utilit\\w*', 'power plant', 'fuel']) },
  { category: 'Debt',           group: 'Fiscal Policy',    re: re(['sovereign\\w*', 'eurobond\\w*', 'bond\\w*', 'credit rating', 'debt restructur', 'public debt', 'national debt', 'default\\w*', 'restructur\\w*', 'imf\\b']) },
  { category: 'Fiscal Policy',  group: 'Fiscal Policy',    re: re(['budget\\w*', 'fiscal', 'deficit', 'surplus\\w*', 'tax(?!i)\\w*', 'taxation', 'revenue', 'expenditure', 'subsid\\w*', 'treasur\\w*']) },
  { category: 'Inflation',      group: 'Macro',            re: re(['inflation', 'deflation', 'cost of living', 'consumer price', '\\bcpi\\b', 'price\\w*']) },
  // "world bank" / "development bank" are multilateral development finance, not retail
  // banking — the lookbehind keeps them out of this bucket (they fall through to Macro).
  { category: 'Banking',        group: 'Finance',          re: re(['central bank', 'monetar\\w*', 'interest rate', '(?<!world )(?<!development )bank\\w*', 'loan\\w*', 'lending', 'mortgage\\w*', 'fintech', 'deposit\\w*']) },
  { category: 'Investment',     group: 'Investment',       re: re(['fdi', 'invest(?!igat)\\w*', 'acquisition\\w*', 'acquir\\w*', 'merger\\w*', 'takeover', 'buyout', 'divest\\w*', 'privatiz\\w*', 'concession\\w*', 'joint venture', 'stake in', 'ipo\\b', 'capital raise']) },
  { category: 'Trade',          group: 'Trade & Tourism',  re: re(['trade\\w*', 'export\\w*', 'import(?!ant)\\w*', 'tariff\\w*', 'customs', 'shipping', 'cargo', 'freight', '\\bwto\\b']) },
  { category: 'Tourism',        group: 'Trade & Tourism',  re: re(['tourism', 'tourist\\w*', 'hotel\\w*', 'resort\\w*', 'cruise\\w*', 'airline\\w*', 'visitor arrival']) },
  { category: 'Infrastructure', group: 'Investment',       re: re(['infrastructure', 'construction', 'ports?\\b', 'airports?', 'highway', '\\broads?\\b', 'bridge', 'logistic\\w*', 'housing', 'real estate']) },
  { category: 'Labor',          group: 'Macro',            re: re(['employ\\w*', 'unemploy\\w*', 'jobs?\\b', 'labou?r\\w*', 'wage\\w*', 'salar\\w*', 'workforce', 'layoffs?', 'redundanc\\w*', 'union\\b', 'pension\\w*']) },
  { category: 'Corporate',      group: 'Finance',          re: re(['earnings', 'profit\\w*', 'dividend\\w*', 'shareholder\\w*', 'stock\\w*', 'equit\\w*', 'company', 'corporate', 'business\\w*', 'enterprise\\w*']) },
];

/**
 * Assign a macro category + filter-bar group to a headline.
 * Falls back to Macro when no specific rule matches.
 * @param {string} title
 * @param {string[]} [tags]
 * @returns {{ category: string, group: string }}
 */
export function classifyNews(title, tags = []) {
  const hay = norm(`${title} ${(tags ?? []).join(' ')}`);
  for (const rule of RULES) {
    if (rule.re.test(hay)) return { category: rule.category, group: rule.group };
  }
  return { category: 'Macro', group: 'Macro' };
}

// The filter-bar buttons, in display order. "All" is handled in the UI.
export const NEWS_GROUPS = ['Macro', 'Energy', 'Finance', 'Fiscal Policy', 'Investment', 'Trade & Tourism'];
