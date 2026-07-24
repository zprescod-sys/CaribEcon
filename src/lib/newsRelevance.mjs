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
 *   1. No economic subject                     → DROP (not our beat).
 *   2. Subject word without supporting context → DROP as weak evidence.
 *   3. Plausible but incomplete/mixed evidence → REVIEW; never publish automatically.
 *   4. Independent economic evidence roles     → PUBLISH.
 *
 * A category word labels a story; it does not admit one. Thus a generic sector noun
 * cannot publish on its own, regardless of which ambiguous word appears next.
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
  'fintech', 'bank\\w*', 'loan\\w*', 'lending', 'credit', 'bond\\w*', 'treasur(?:y|ies)\\b', 'mortgage\\w*',
  'insur\\w*', 'reinsur\\w*', 'underwrit\\w*', 'actuar\\w*', 'annuit\\w*',
  'market\\w*', 'stock market', 'stock exchange', 'stock prices?', 'stocks\\b', 'shares?\\b',
  'shareholder\\w*', 'equit\\w*', 'ipo', 'dividend\\w*', 'earnings', 'profit\\w*', 'turnover',
  'business\\w*', 'commerc\\w*', 'corporate', 'compan(?:y|ies)', 'enterprise\\w*',
  // corporate reporting & intellectual property. patents?\b (not patent\w*) so
  // "patently false" political stories don't match.
  'esg\\b', 'wipo\\b', 'patents?\\b', 'trademark\\w*',
  'manufactur\\w*', 'industr\\w*', 'factory', 'production',
  'agricultur\\w*', 'farm\\w*', 'crop\\w*', 'commodit\\w*', 'sugar', 'banana\\w*', 'rice', 'cocoa', 'coffee', '\\brum\\b',
  'mining', 'bauxite', 'gold\\b', 'quarr\\w*',
  'shipping', 'ports?\\b', 'seaports?', 'airports?', 'harbour\\w*', 'logistic\\w*', 'cargo', 'freight', 'vessel\\w*', 'bridge\\w*',
  'employ\\w*', 'unemploy\\w*', 'jobs?\\b', 'labou?r(?:er|ers|ing|ed)?\\b',
  'wage\\w*', 'salar\\w*', 'workforce', 'layoffs?', 'redundanc\\w*',
  'pension\\w*', 'recession', 'growth', 'productiv\\w*', 'subsid\\w*', 'prices?\\b', 'pricing\\b',
  'default\\w*', 'restructur\\w*', 'ratings?\\b', 'procurement', 'tenders?\\b',
  'merger\\w*', 'acquisition\\w*', 'acquir\\w*', 'takeover', 'buyout', 'divest\\w*', 'privatiz\\w*', 'concession\\w*',
  'infrastructure', 'construction', 'housing',
]);
const INCLUDE_PHRASES = [
  'world bank', 'central bank', 'interest rate', 'exchange rate', 'cost of living', 'credit rating',
  'real estate', 'private sector', 'public sector', 'gross domestic', 'balance of payments',
  'current account', 'foreign exchange', 'development bank', 'stake in', 'joint venture', 'free trade',
  'doing business', 'sovereign wealth', 'natural resource fund', 'per capita', 'ease of doing',
  'sustainability report', 'intellectual property', 'ESG'
];

// ── Strong: unambiguous economics (overrides a single exclusion signal) ───────
// Deliberately narrow. Bare "debt"/"bond"/"oil"/"business" are NOT strong — they co-occur
// too easily with crime/sport (bail bond, oil-firm football sponsorship). Only terms that
// are almost always genuine macro/finance qualify to rescue an otherwise-excluded headline.
const STRONG_RE = re([
  'gdp', 'inflation', 'deflation', 'fiscal', 'monetar\\w*', 'budget\\w*', 'deficit', 'surplus\\w*',
  'tariff\\w*', 'imf', 'eclac', 'unctad', 'idb\\b', 'cdb\\b', 'fdi', 'sovereign\\w*', 'eurobond\\w*', 'taxation',
  'tax(?!i)\\w*', 'revenue', 'expenditure', 'remittance\\w*', 'privatiz\\w*', 'devalu\\w*', 'recession',
  'subsid\\w*', 'procurement', 'esg\\b', 'inflatie', 'begroting', 'staatsschuld',
  'wisselkoers', 'olieprijzen', 'gasvondst',
]);
const STRONG_PHRASES = [
  'world bank', 'central bank', 'interest rate', 'exchange rate', 'cost of living', 'credit rating',
  'balance of payments', 'current account', 'foreign exchange', 'bond issue', 'sovereign debt',
  'public debt', 'national debt', 'debt restructur', 'trade deficit', 'fiscal deficit',
  'export earnings', 'oil production', 'gas production', 'oil rig', 'gas field', 'refinery',
  'economic growth', 'per capita', 'sustainability report', 'financial results',
  'quarterly results', 'annual results', 'financial statements',
];

// ── Exclude: off-topic signals (sport / crime / entertainment / lifestyle) ────
// Terms too ambiguous to filter safely are intentionally omitted: "fire" (layoffs/fire-sale),
// "crash" (market crash), "goal"/"final" (policy goals, final budget), "match" (matched funds).
const EXCLUDE_RE = re([
  // sport
  'sport\\w*', 'games?\\b', 'fifa\\b', 'world cup', 'football\\w*', 'cricket\\w*',
  'netball\\w*', 'basketball', 'volleyball', 'rugby', 'athletic\\w*',
  'sprint\\w*', 'olympic\\w*', 'commonwealth games', 'tournament\\w*', 'championship\\w*', '\\bleague\\b',
  'playoffs?', 'semifinal\\w*', 'quarterfinal\\w*', 'fixtures?\\b', 'strikers?\\b', 'midfielder\\w*',
  'batsm(?:a|e)n', 'bowler\\w*', 'wicket\\w*', 'innings', 'goalkeeper', 'coach\\w*', 'squad', 'medal\\w*',
  'marathon', 'regatta', 'cyclist\\w*', 'boxing', 'boxer\\b', 'footballers?', 'netballers?', 'windies',
  // athletics events — added so "long jump gold" / "NACAC" medal stories are dropped
  // outright instead of leaking in on a bare "gold" and cluttering the review queue.
  'long jump', 'high jump', 'triple jump', 'javelin\\b', '\\bnacac\\b',
  // crime / court / police
  'murder\\w*', 'homicide', 'manslaughter', 'killed\\b', 'shot\\b', 'shooting\\w*', 'gunm(?:a|e)n',
  'gunshot\\w*', 'stabb\\w*', 'wounded', 'rape[ds]?\\b', 'rapist', 'molest\\w*', 'assault\\w*', 'kidnap\\w*',
  'ransom', 'robber\\w*', 'robbed', 'burglar\\w*', 'theft\\b', 'thief\\b', 'stolen', 'arrest\\w*',
  'charged\\b', 'remand\\w*', 'bail\\b', 'accused', 'suspect\\w*', 'convict\\w*', 'sentenced', 'jailed',
  'prison\\w*', 'court\\b', 'magistrate', 'police\\b', 'cocaine', 'marijuana', 'ganja', 'cannabis',
  'traffick\\w*', 'smuggl\\w*', 'gang\\b', 'shootout', 'machete', 'accident\\w*', 'injured',
  'criminal\\w*', 'fraud\\w*', 'scams?\\b', 'lawsuit\\w*', 'petition\\w*', 'victimis\\w*',
  'divorce\\w*', 'airlift\\w*', 'rescu\\w*', 'hospital\\w*',
  // emergencies / personal incidents. A measured economic consequence can still
  // reach review, but an industry noun cannot turn the incident into business news.
  'fires?\\b', 'burn(?:s|ed|ing)?\\b', 'blaze\\w*', 'explosion\\w*', 'falls? into',
  'euthanasi\\w*',
  // death / fatality (human-interest & crime). Word-boundaried so "deadline"/"studied"/
  // "bodies" don't false-match; none of these are strong-economic, so a real pension/
  // fund story with no death word still passes.
  'found dead', '\\bdead\\b', '\\bdeath\\b', 'body found', 'bodies found', 'deceased', '\\bdies\\b',
  '\\bdied\\b', 'fatal\\w*', 'drown\\w*', 'corpse', 'remains found', '\\bmissing\\b',
  // entertainment / culture
  'entertainment', 'editorials?\\b', 'carnival', 'calypso\\w*', 'soca\\b', 'dancehall',
  'reggae', 'concert\\w*', 'festival\\w*', 'pageant\\w*',
  'beauty queen', 'miss universe', 'fashion', 'movie\\w*', 'film\\w*', 'actor\\b', 'actress', 'singer\\w*',
  'album\\b', 'mixtape', 'celebrit\\w*', 'music\\b',
  // human-interest / community / lifestyle
  'obituar\\w*', 'funeral\\w*', 'wedding\\w*', 'birthday\\w*', 'graduat\\w*', 'valedictorian',
  'scholarship\\w*', 'school\\w*', 'student\\w*', 'church\\w*', 'pastor', 'bishop', 'congregation',
  'recipe\\w*', 'cooking\\b', 'lifestyle', 'horoscope', 'zodiac', 'heartwarming', 'gofundme', 'puppy',
  'seizures?\\b', 'medical', 'illness', 'diagnos\\w*', 'job vacanc\\w*',
  'employment opportunit\\w*',
  // tributes / remembrance (the "Best Friend Remembers…" class of story). "passing" is
  // deliberately excluded from this list — it collides with "passing" legislation/a budget.
  'tribute\\w*', 'remembers\\b', 'remembered\\b', 'remembering\\b', 'in memoriam', 'laid to rest',
  'mourns?\\b', 'mourning', 'condolence\\w*', 'loved ones', 'best friend', 'rest in peace',
  // Institutional and security activity is not economic merely because equipment or
  // funding is mentioned. Substantive economic evidence can still override this context.
  'defen[cs]e force', 'department of defen[cs]e', 'department of war', 'military',
  'air guard', 'armed forces', 'fighter jets?', 'weapons?\\b', 'security exercise',
  'training camp',
]);

// ── Evidence roles ────────────────────────────────────────────────────────────
// INCLUDE_RE identifies possible subject matter; it never authorizes publication by
// itself. Publication requires independent evidence of an economic action, outcome,
// measurement, or institution. Decisions therefore depend on relationships between
// signals instead of maintaining a deny-list of ambiguous subject words.
const ECONOMIC_ACTION_RE = re([
  'cut\\w*', 'increas\\w*', 'decreas\\w*', 'ris(?:e|es|ing|en)\\b', 'rose\\b',
  'fall\\w*', 'fell\\b', 'declin\\w*', 'grow\\w*', 'grew\\b', 'expand\\w*', 'boost\\w*',
  'recover\\w*', 'rebound\\w*', 'fund\\w*', 'allocat\\w*', 'approv\\w*', 'launch\\w*',
  'open(?:s|ed|ing)?\\b', 'clos(?:e|es|ed|ing)\\b', 'complet\\w*', 'begin\\w*', 'start\\w*',
  'build\\w*', 'construct(?:s|ed|ing)?\\b', 'rehabilitat\\w*', 'rebuild\\w*', 'exceed\\w*',
  'sign(?:s|ed|ing)?\\b', 'secur(?:e|es|ed|ing)\\b', 'acquir\\w*', 'merg\\w*', 'divest\\w*',
  'export\\w*', 'import(?!ant)\\w*', 'hir(?:e|es|ed|ing)\\b', 'layoffs?', 'borrow\\w*',
  'lend\\w*', 'repay\\w*', 'spend\\w*', 'issue\\w*', 'forecast\\w*', 'project(?:ed|ing)\\b',
  'target\\w*', 'produce\\w*', 'manufactur\\w*', 'supply\\w*', 'lift\\w*', 'drop\\w*',
  'improv\\w*', 'back(?:s|ed|ing)\\b', 'support(?:s|ed|ing)\\b', 'hik\\w*', 'scrap\\w*',
  'return(?:s|ed|ing)?\\b', 'resum\\w*', 'unveil\\w*', 'releas\\w*', 'announc\\w*',
  'add(?:s|ed|ing)?\\b',
  'buy(?:s|ing)?\\b', 'bought\\b', 'sell(?:s|ing)?\\b', 'sold\\b', 'deliver\\w*', 'charg\\w*',
  'stijg\\w*', 'daal\\w*', 'groei\\w*', 'financier\\w*', 'investeer\\w*',
  'verhoog\\w*', 'verlaag\\w*', 'bouw\\w*', 'exporteer\\w*', 'produceer\\w*',
]);

const ECONOMIC_OUTCOME_RE = re([
  'production', 'output', 'capacity', 'profit\\w*', 'earnings', 'revenue', 'sales', 'turnover',
  'employment', 'unemployment', 'jobs?\\b', 'wage\\w*', 'salary', 'prices?\\b', 'costs?\\b',
  'export\\w*', 'import(?!ant)\\w*', 'visitor arrivals?', 'supply', 'demand', 'productiv\\w*',
  'competitiveness', 'affordability', 'growth', 'recession', 'recovery', 'deficit', 'surplus\\w*',
  'public debt', 'national debt', 'investment', 'funding', 'financing',
  'grant (?:funding|financing)', 'grants? (?:worth|of|for)',
  'lending', 'repayment', 'payments?\\b', 'pension(?:s| benefits?| payments?| drawdowns?)?\\b',
  'deals?\\b', 'contracts?\\b', 'agreements?\\b', 'mou\\b', 'acquisition\\w*', 'merger\\w*',
  'takeover\\w*', 'divestment\\w*', 'sales?\\b', 'completion', 'expansion',
  'assets?\\b', 'liabilit\\w*', 'reserves?', 'fares?\\b', 'fees?\\b', 'charges?\\b',
  'transfers?\\b', 'partnerships?\\b', 'licen[cs](?:e|es|ed|ing)\\b', 'permits?\\b',
  'regulations?\\b', 'rules?\\b', 'bans?\\b', 'routes?\\b', 'flights?\\b', 'seats?\\b',
  'stakes?\\b', 'change in control', 'passenger traffic', 'airport traffic', 'air arrivals?',
  'productie', 'winst', 'omzet', 'prijzen', 'schuld', 'werkgelegenheid', 'groei', 'financiering',
  'interest rate', 'exchange rate', 'foreign exchange', 'market (?:closes?|closed|opens?|rose|rises|fell|falls|gains?|lost)',
]);

const ECONOMIC_INSTITUTION_RE = re([
  'world bank', 'central bank', 'development bank', 'international monetary fund', 'imf\\b',
  'caribbean development bank', 'cdb\\b', 'inter-american development bank', 'idb\\b',
  'eastern caribbean central bank', 'eccb\\b', 'stock exchange', 'securities exchange',
  'ministry of finance', 'finance ministry', 'treasury', 'tax authority', 'revenue authority',
  'economic commission', 'eclac', 'unctad', 'oecd', 'public utilities commission', '\\bpuc\\b',
]);

const ECONOMIC_ACTOR_RE = re([
  'compan(?:y|ies)', 'corporat\\w*', 'firms?\\b', 'manufacturer\\w*', 'producer\\w*',
  'operator\\w*', 'utilit\\w*', 'bank\\w*', 'insur\\w*', 'airline\\w*', 'hotel\\w*',
  'industry', '\\bsector\\b', 'enterprise\\w*', 'private sector',
]);

const ECONOMIC_PROJECT_RE = re([
  'projects?\\b', 'programmes?\\b', 'facilit(?:y|ies)', 'terminals?\\b', 'power plants?\\b',
  'refiner(?:y|ies)', 'mines?\\b', 'housing schemes?\\b', 'industrial parks?\\b',
  'transmission network', 'transport network', 'road works', 'construction',
  'refurbishment', 'expansion',
]);

const PERSONNEL_OR_CEREMONIAL_RE = re([
  'appoint\\w*', 'elect\\w*', 'names?\\b', 'introduces?\\b', 'executive team', 'chief executive',
  '\\bceo\\b', 'president of', 'chair(?:man|woman|person|manship)?\\b', 'award\\w*', 'anniversary',
  'attends?\\b', 'interns?\\b', 'training camp', 'scholarship\\w*', 'closing statement',
]);

const POLITICAL_PROCESS_RE = re([
  'campaign finance', 'campaign funding', 'election\\w*', 'political persecution',
  'opposition leader', 'political party', 'opposition party', 'ruling party',
  'party leader', 'party candidate', 'party financing', 'party funding', 'constituency',
]);

const ECONOMIC_MEASURE_RE = /(?:us|tt|gy|jm|bb|bs|bz|ec)?[$€£]\s*\d|\b(?:usd|ttd|gyd|jmd|bbd|bsd|bzd|xcd|srd)\s*\d|\b(?:\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:%|per\s*cent\b|percent\b|bn\b|mn\b|million\b|billion\b|trillion\b|miljard\b|miljoen\b|barrels?\b|tonnes?\b|tons?\b|ounces?\b|mw\b|megawatts?\b|jobs?\b|acres?\b|units?\b|rooms?\b|flights?\b|seats?\b|routes?\b)/i;
const DIRECT_MARKET_EVENT_RE = /(?:\bforex(?:\s+rate)?\s*:|\bmarket\s+(?:closes?|closed|opens?|rose|rises|fell|falls|gains?|lost)\b|\bshares?\s+(?:rose|rise|rises|fell|fall|falls|gain\w*|lose\w*)\b|\bcurrenc\w*\s+(?:appreciat\w*|depreciat\w*)\b)/i;

// ── Classification: which macro category, for the card tag + filter bar ───────
// Each rule maps to a display `category` (the chip on the card) and a `group` (the
// coarse bucket the News filter bar toggles). First match wins, so order = priority.
const RULES = [
  { category: 'Energy',         group: 'Energy',           re: re(['oil', 'gas(?!t)\\w*', 'olie\\w*', 'petronas', 'lng', 'petroleum', 'crude', 'refiner\\w*', 'barrel\\w*', 'energy', 'electricity', 'renewable\\w*', 'solar', 'utilit\\w*', 'power plant', 'power (?:charges?|prices?|rates?)', 'fuel']) },
  { category: 'Debt',           group: 'Fiscal Policy',    re: re(['sovereign\\w*', 'eurobond\\w*', 'bond\\w*', 'credit rating', 'debt restructur', 'public debt', 'national debt', 'default\\w*', 'restructur\\w*', 'imf\\b']) },
  { category: 'Fiscal Policy',  group: 'Fiscal Policy',    re: re(['budget\\w*', 'fiscal', 'deficit', 'surplus\\w*', 'tax(?!i)\\w*', 'taxation', 'revenue', 'expenditure', 'subsid\\w*', 'treasur(?:y|ies)\\b']) },
  { category: 'Inflation',      group: 'Macro',            re: re(['inflation', 'deflation', 'cost of living', 'consumer price', '\\bcpi\\b', 'prices?\\b', 'pricing\\b']) },
  // "world bank" / "development bank" are multilateral development finance, not retail
  // banking — the lookbehind keeps them out of this bucket (they fall through to Macro).
  { category: 'Banking',        group: 'Finance',          re: re(['central bank', 'monetar\\w*', 'interest rate', '(?<!world )(?<!development )bank\\w*', 'loan\\w*', 'lending', 'mortgage\\w*', 'fintech', 'deposit\\w*', 'insur\\w*', 'reinsur\\w*', 'underwrit\\w*', 'capital market\\w*']) },
  { category: 'Investment',     group: 'Investment',       re: re(['fdi', 'invest(?!igat)\\w*', 'acquisition\\w*', 'acquir\\w*', 'merger\\w*', 'takeover', 'buyout', 'divest\\w*', 'privatiz\\w*', 'concession\\w*', 'joint venture', 'stake in', 'ipo\\b', 'capital raise', 'mining', 'bauxite', 'gold\\b', 'quarr\\w*']) },
  { category: 'Trade',          group: 'Trade & Tourism',  re: re(['trade\\w*', 'export\\w*', 'import(?!ant)\\w*', 'tariff\\w*', 'customs', 'shipping', 'cargo', 'freight', '\\bwto\\b', 'ports?\\b', 'seaports?', 'harbour\\w*']) },
  { category: 'Tourism',        group: 'Trade & Tourism',  re: re(['tourism', 'tourist\\w*', 'hotel\\w*', 'resort\\w*', 'cruise\\w*', 'airline\\w*', 'airports?', 'visitor arrival']) },
  { category: 'Infrastructure', group: 'Investment',       re: re(['infrastructure', 'construction', 'highway', '\\broads?\\b', 'bridge', 'logistic\\w*', 'housing', 'real estate']) },
  { category: 'Labor',          group: 'Macro',            re: re(['employ\\w*', 'unemploy\\w*', 'jobs?\\b', 'labou?r(?:er|ers|ing|ed)?\\b', 'wage\\w*', 'salar\\w*', 'workforce', 'layoffs?', 'redundanc\\w*', 'union\\b', 'pension\\w*']) },
  { category: 'Corporate',      group: 'Finance',          re: re(['earnings', 'profit\\w*', 'dividend\\w*', 'shareholder\\w*', 'stock market', 'stock exchange', 'stock prices?', 'stocks\\b', 'shares?\\b', 'equit\\w*', 'company', 'corporate', 'business\\w*', 'enterprise\\w*', 'esg\\b', 'sustainability report\\w*', 'wipo\\b', 'patents?\\b', 'trademark\\w*', 'intellectual property']) },
];

// Public editorial categories and their filter-bar groups. Approved inbox rows use
// this map so a manually assigned category always lands in the correct UI group.
export const NEWS_CATEGORY_GROUPS = Object.freeze({
  Macro: 'Macro',
  Energy: 'Energy',
  Debt: 'Fiscal Policy',
  'Fiscal Policy': 'Fiscal Policy',
  Inflation: 'Macro',
  Banking: 'Finance',
  Investment: 'Investment',
  Trade: 'Trade & Tourism',
  Tourism: 'Trade & Tourism',
  Infrastructure: 'Investment',
  Labor: 'Macro',
  Corporate: 'Finance',
});

// Narrow edge-case rules for the editorial inbox. These do NOT make a story public;
// they only identify plausible economic stories whose vocabulary the strict public
// classifier does not yet understand (for example an operator + "deepwater").
const REVIEW_RULES = [
  {
    category: 'Energy',
    re: re([
      'exxonmobil', 'exxon', 'chevron', 'hess', 'shell\\b', 'bp\\b', 'petronas', 'repsol',
      'deepwater', 'offshore', 'upstream', 'downstream', 'hydrocarbon\\w*', 'drill\\w*',
      'exploration', 'production sharing', 'fpsos?\\b', 'stabroek', 'yellowtail', 'liza',
      'payara', 'hammerhead',
    ]),
  },
  {
    category: 'Investment',
    re: re(['expansion plan', 'project financing', 'greenfield', 'brownfield']),
  },
  {
    category: 'Corporate',
    re: re(['chief executive', '\\bceo\\b', 'annual report', 'quarterly results', 'operating profit']),
  },
];

const BUSINESS_FEED_EDGE_RE = re([
  '\\bfirm\\b', '\\bsector\\b', '\\bindustry\\b', '\\bcontract\\b', '\\bproject\\b',
  '\\bdeal\\b', '\\bmillion\\b', '\\bbillion\\b', '\\bceo\\b', 'chief executive',
]);

// ── Editorial assessment ──────────────────────────────────────────────────────
// Category rules label an already-relevant story; they do not prove relevance. The
// confidence level is based on independent evidence roles in the title:
//   high   — enough contextual economic evidence to publish automatically.
//   medium — plausibly economic but incomplete or conflicting; editorial review only.
//   weak   — an economic subject word without enough context; drop without review.
//   low    — no economic evidence in the title; drop without review.
// Tags are advisory metadata used only to suggest a category for a medium candidate.
export const CONFIDENCE_RANK = { low: 0, weak: 1, medium: 2, high: 3 };
export const MIN_NEWS_CONFIDENCE = 'high';

function titleHasInclude(hay) {
  return INCLUDE_RE.test(hay) || INCLUDE_PHRASES.some(p => hay.includes(p));
}

function titleHasDirectEconomicEvidence(hay) {
  return STRONG_RE.test(hay)
    || STRONG_PHRASES.some(p => hay.includes(p))
    || DIRECT_MARKET_EVENT_RE.test(hay);
}

function evidenceReason(parts) {
  return parts.length ? parts.join(', ') : 'no independent economic context';
}

/**
 * Produce the single publish/review/drop decision used by ingest, review, and render.
 * @param {string} title
 * @param {string[]} [tags]
 * @param {{ businessFeed?: boolean }} [context]
 * @returns {{ decision: 'publish'|'review'|'drop', category: string, group: string, confidence: 'low'|'weak'|'medium'|'high', reason: string }}
 */
export function assessNews(title, tags = [], context = {}) {
  const titleHay = norm(title);
  const tagHay = norm((tags ?? []).join(' '));
  const titleRule = RULES.find(rule => rule.re.test(titleHay));
  const reviewRule = REVIEW_RULES.find(rule => rule.re.test(titleHay));
  const tagRule = RULES.find(rule => rule.re.test(tagHay));
  const businessEdge = Boolean(context.businessFeed) && BUSINESS_FEED_EDGE_RE.test(titleHay);

  const hasSubject = titleHasInclude(titleHay);
  const hasDirect = titleHasDirectEconomicEvidence(titleHay);
  const hasAction = ECONOMIC_ACTION_RE.test(titleHay);
  const hasOutcome = ECONOMIC_OUTCOME_RE.test(titleHay);
  const hasMeasure = ECONOMIC_MEASURE_RE.test(titleHay);
  const hasInstitution = ECONOMIC_INSTITUTION_RE.test(titleHay);
  const hasActor = ECONOMIC_ACTOR_RE.test(titleHay);
  const hasProject = ECONOMIC_PROJECT_RE.test(titleHay);
  const hasOffDomain = EXCLUDE_RE.test(titleHay);
  const hasPersonnelContext = PERSONNEL_OR_CEREMONIAL_RE.test(titleHay);
  const hasPoliticalProcess = POLITICAL_PROCESS_RE.test(titleHay);

  const category = titleRule?.category
    ?? reviewRule?.category
    ?? (hasSubject ? 'Macro' : 'Unclassified');
  const group = NEWS_CATEGORY_GROUPS[category] ?? 'Unclassified';
  const suggestedCategory = reviewRule?.category
    ?? tagRule?.category
    ?? (category !== 'Unclassified' ? category : businessEdge ? 'Corporate' : '');

  const evidence = [];
  if (hasDirect) evidence.push('direct economic concept');
  if (hasAction) evidence.push('economic action');
  if (hasOutcome) evidence.push('economic outcome');
  if (hasMeasure) evidence.push('measurement');
  if (hasInstitution) evidence.push('economic institution');
  if (hasActor) evidence.push('economic actor');
  if (hasProject) evidence.push('economic project');

  // Edge rules and a dedicated business feed can make an otherwise terse headline
  // reviewable, but can never make it publishable.
  const contextualReview = Boolean(reviewRule) || businessEdge;

  if (!hasSubject && !contextualReview) {
    return {
      decision: 'drop', category: 'Unclassified', group: 'Unclassified', confidence: 'low',
      reason: 'No economic evidence in the title.',
    };
  }

  // Personnel, ceremonial, and political-process headlines need a real economic result,
  // measurement, or direct policy concept; the organisation or finance word alone is not
  // sufficient. This keeps appointments and campaign disputes out without naming sources.
  const contextOnly = (hasPersonnelContext && !hasOutcome)
    || hasPoliticalProcess;
  if (contextOnly) {
    // A political-process title containing a real macro concept and result can be
    // economically relevant, but requires an editor rather than automatic publication.
    if (hasPoliticalProcess && hasDirect && hasOutcome) {
      return {
        decision: 'review', category, group, confidence: 'medium',
        reason: 'Direct economic evidence appears inside political-process context: '
          + evidenceReason(evidence) + '.',
      };
    }
    return {
      decision: 'drop', category, group, confidence: 'weak',
      reason: 'Economic subject appears only in personnel, ceremonial, or political-process context.',
    };
  }

  const highEvidence = hasDirect
    || (hasSubject && hasOutcome && (hasAction || hasMeasure || hasInstitution || hasActor || hasProject))
    || (hasSubject && hasMeasure && (hasAction || hasInstitution || hasProject))
    || (hasSubject && hasAction && hasProject)
    || (hasInstitution && hasAction && (hasOutcome || hasMeasure));

  if (highEvidence && !hasOffDomain && !contextOnly) {
    return {
      decision: 'publish', category, group, confidence: 'high',
      reason: `Publishable economic evidence: ${evidenceReason(evidence)}.`,
    };
  }

  // An off-domain signal may coexist with a legitimate legal, regulatory, or policy
  // story. Publish only when a direct economic concept has independent support; otherwise
  // send a genuinely mixed case to review instead of letting one keyword rescue it.
  if (hasOffDomain) {
    if (hasDirect && (hasOutcome || hasMeasure) && !contextOnly) {
      return {
        decision: 'publish', category, group, confidence: 'high',
        reason: `Direct economic evidence outweighs conflicting context: ${evidenceReason(evidence)}.`,
      };
    }
    if (highEvidence && (hasInstitution || hasActor || hasProject) && (hasOutcome || hasMeasure)) {
      return {
        decision: 'review', category, group, confidence: 'medium',
        reason: `Economic evidence conflicts with off-domain context: ${evidenceReason(evidence)}.`,
      };
    }
    return {
      decision: 'drop', category, group, confidence: hasSubject ? 'weak' : 'low',
      reason: 'Off-domain context without enough independent economic evidence.',
    };
  }

  const mediumEvidence = contextualReview
    || (hasSubject && (
      hasInstitution
      || (hasActor && (hasAction || hasOutcome || hasMeasure))
      || (hasProject && (hasAction || hasOutcome || hasMeasure))
      || (hasAction && (hasOutcome || hasMeasure))
    ));
  if (mediumEvidence) {
    return {
      decision: 'review',
      category: category === 'Unclassified' ? (suggestedCategory || 'Unclassified') : category,
      group: category === 'Unclassified'
        ? (NEWS_CATEGORY_GROUPS[suggestedCategory] ?? 'Unclassified')
        : group,
      confidence: 'medium',
      reason: `Plausible but incomplete economic evidence: ${evidenceReason(evidence)}.`,
    };
  }

  return {
    decision: 'drop', category, group, confidence: hasSubject ? 'weak' : 'low',
    reason: 'Economic subject detected without a clear action, outcome, measurement, or institution.',
  };
}

/** True when the title is publishable or merits editorial review. */
export function isRelevantNews(title, tags = []) {
  return assessNews(title, tags).decision !== 'drop';
}

/** Assign the category and evidence-based confidence used by cards and filters. */
export function classifyNews(title, tags = []) {
  const { category, group, confidence } = assessNews(title, tags);
  return { category, group, confidence };
}

/** The public gate used at both ingest and render. Medium is review-only. */
export function isDisplayableNews(title, tags = []) {
  return assessNews(title, tags).decision === 'publish';
}

/** Stage medium decisions only; weak and low items do not clutter the inbox. */
export function getNewsReviewDecision(title, tags = [], context = {}) {
  const assessment = assessNews(title, tags, context);
  return {
    candidate: assessment.decision === 'review',
    suggestedCategory: assessment.category === 'Unclassified' ? '' : assessment.category,
    confidence: assessment.confidence,
    reason: assessment.reason,
  };
}

// The filter-bar buttons, in display order. "All" is handled in the UI.
export const NEWS_GROUPS = ['Macro', 'Energy', 'Finance', 'Fiscal Policy', 'Investment', 'Trade & Tourism'];
