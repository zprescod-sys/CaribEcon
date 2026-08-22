/* compileEvidence() — the deterministic Evidence Compiler (Synthesis Latency + Evidence Compiler
 * upgrade, Stage B). Pure TypeScript, no model call, no I/O.
 *
 * Sits between executeResearchPlan() and synthesize(): takes the full, real EvidencePackage and
 * produces a second, COMPACT view (CompiledEvidence) for the synthesis prompt only. This is
 * organisation and compression, never reasoning — every EvidenceItem it emits traces back to real
 * EvidencePackage refs via its own `refs: EvidenceRef[]`, and grounding.ts NEVER reads this
 * output; it keeps checking claims against the original, untouched EvidencePackage exactly as
 * before this upgrade. Compaction changes what the synthesizer sees, never what code verifies —
 * see the plan's own "safety-critical design decision" section for the full reasoning.
 *
 * Responsibilities, each independently testable below: normalize (data/news/web -> EvidenceItem),
 * deduplicate (exact-match only — see dedupe functions' own headers for why not semantic),
 * rank by source quality (compilerQualityTier — computed here, never written back onto the raw
 * evidence types), rank by relevance to the actual question, detect conflicts (correctly
 * normalized — see detectStatisticConflicts), and enforce hard budget invariants
 * (MAX_KEY_FACTS/MAX_DRIVER_ITEMS/MAX_CONCEPTS/MAX_EXTERNAL_FINDINGS/MAX_CONTRADICTIONS, config.ts)
 * so the latency control this whole stage exists for is a tested fact, not a hope.
 */
import { evidenceId, resolveIndicator, type EvidencePackage, type DataEvidence, type NewsEvidence } from '../askTools.js';
import { yoy_change, pp_change, period_average } from '../calculations.js';
import { calculationForUnit } from '../excelOutputs.js';
import {
  MAX_KEY_FACTS,
  MAX_DRIVER_ITEMS,
  // MAX_CONCEPTS is not imported here — economicConcepts is always [] this pass (Knowledge Hub
  // deferred); the constant still exists in config.ts, enforced once concepts are populated.
  MAX_EXTERNAL_FINDINGS,
  MAX_CONTRADICTIONS,
} from './config.js';
import type {
  CompiledEvidence,
  CompilerQualityTier,
  EvidenceContradiction,
  EvidenceItem,
  EvidenceLimitation,
  EvidenceNote,
  EvidenceRef,
  NewsContextItem,
  ResearchIntent,
  ResearchPlan,
  StatisticItem,
  WebEvidence,
} from './contracts.js';

const TIER_RANK: Record<CompilerQualityTier, number> = { primary: 3, comparable: 2, journalism: 1, unverified: 0 };

// ── Quality tier — compiler-only, never written back onto raw evidence (see file header) ──────

// Domains this pass recognises as IMF/World Bank/CDB/IDB-equivalent — a starting heuristic to
// refine, not an authoritative registry (plan's own stated scope for this ranking step).
const COMPARABLE_DOMAINS = ['imf.org', 'worldbank.org', 'cdb.org', 'iadb.org', 'un.org'];

function isComparableDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return COMPARABLE_DOMAINS.some(known => d === known || d.endsWith(`.${known}`));
}

function tierForData(d: DataEvidence): CompilerQualityTier {
  return d.sourceTier === 'primary' ? 'primary' : 'comparable';
}

function tierForWeb(w: WebEvidence): CompilerQualityTier {
  if (isComparableDomain(w.domain)) return 'comparable';
  return w.extract ? 'journalism' : 'unverified'; // real extracted content vs. a bare search snippet
}

// News Hub items are already vetted by the LLM classifier/human review before publication
// (news.ts's own header) — treated as 'journalism' uniformly, same tier as an extracted web
// article from a named outlet.
const TIER_FOR_NEWS: CompilerQualityTier = 'journalism';

// ── Normalize: DataEvidence -> StatisticItem[] ─────────────────────────────────────────────

/* Representative points only, never one item per year — a 25-year series compiling into 25
 * StatisticItems would defeat the whole point of this stage. Picks: the latest point with a
 * real value; the earliest point within the requested window if the question specified one and
 * it differs from the latest (trend context); the latest year-over-year/percentage-point change;
 * the period average. Up to four items per series, not twenty-five. */
function normalizeDataSeries(d: DataEvidence, intent: ResearchIntent): StatisticItem[] {
  const ref: EvidenceRef = `D:${evidenceId(d.country, d.indicator)}`;
  const tier = tierForData(d);
  const items: StatisticItem[] = [];

  const withValue = d.points.filter(p => p.value !== null);
  if (!withValue.length) return items;

  const sorted = [...withValue].sort((a, b) => a.year - b.year);
  const latest = sorted[sorted.length - 1];
  items.push({
    type: 'statistic',
    refs: [ref],
    country: d.country,
    indicator: d.indicator,
    period: String(latest.year),
    value: latest.value as number,
    unit: d.unit,
    valueType: latest.type,
    transformation: null,
    compilerQualityTier: tier,
  });

  if (intent.yearFrom !== null) {
    const boundary = sorted.find(p => p.year === intent.yearFrom) ?? sorted[0];
    if (boundary.year !== latest.year) {
      items.push({
        type: 'statistic',
        refs: [ref],
        country: d.country,
        indicator: d.indicator,
        period: String(boundary.year),
        value: boundary.value as number,
        unit: d.unit,
        valueType: boundary.type,
        transformation: null,
        compilerQualityTier: tier,
      });
    }
  }

  const calcName = calculationForUnit(d.unit);
  const changes = (calcName === 'pp_change' ? pp_change : yoy_change)(d.points);
  const latestChange = [...changes].reverse().find(c => c.value !== null);
  if (latestChange) {
    items.push({
      type: 'statistic',
      refs: [ref],
      country: d.country,
      indicator: d.indicator,
      period: String(latestChange.year),
      value: latestChange.value as number,
      unit: calcName === 'pp_change' ? 'pp' : '%',
      valueType: 'derived',
      transformation: calcName,
      compilerQualityTier: tier,
    });
  }

  const avg = period_average(d.points);
  if (avg.value !== null) {
    items.push({
      type: 'statistic',
      refs: [ref],
      country: d.country,
      indicator: d.indicator,
      period: String(avg.year),
      value: avg.value,
      unit: d.unit,
      valueType: 'derived',
      transformation: 'period_average',
      compilerQualityTier: tier,
    });
  }

  return items;
}

// ── Normalize: NewsEvidence -> NewsContextItem[] ───────────────────────────────────────────

function normalizeNewsItem(n: NewsEvidence): NewsContextItem {
  return {
    type: 'news_context',
    refs: [`N:${n.id}`],
    country: n.country === 'ALL' ? null : n.country,
    claim: n.title,
    mechanism: null,
    confidence: null,
    source: n.source,
    date: n.date,
    topics: n.tags ?? (n.category ? [n.category] : []),
    compilerQualityTier: TIER_FOR_NEWS,
  };
}

// ── Normalize: WebEvidence -> NewsContextItem[] + StatisticItem[] ─────────────────────────

/* Per the plan's Stage-B revision: a plain Tavily item (no Stage-A structured insights) compiles
 * from its `snippet` ONLY — never a slice of `extract.text`. A raw-text slice is exactly the
 * "evidence dump sneaking back into synthesis" this stage exists to prevent; the full text stays
 * exclusively in the untouched EvidencePackage for grounding/provenance. extract_web pages now DO
 * get Stage-A structured extraction (executor.ts's extract_web branch calls
 * extractArticleInsights() with the 'webExtract' role, newsExtract.ts) — this branch is what
 * still applies when that role is unconfigured, or the model call/parse failed, so `insights` is
 * null: the page still compiles, just from its snippet rather than losing it entirely. */
function normalizeWebItem(w: WebEvidence): { context: NewsContextItem[]; figures: StatisticItem[] } {
  const ref: EvidenceRef = w.id.startsWith('W:') ? (w.id as EvidenceRef) : (`W:${w.id}` as EvidenceRef);
  const tier = tierForWeb(w);
  const insights = w.extract?.insights ?? null;

  if (!insights) {
    return {
      context: [
        {
          type: 'news_context',
          refs: [ref],
          country: null,
          claim: w.snippet || w.title,
          mechanism: null,
          confidence: null,
          source: w.domain,
          date: w.publishedDate,
          topics: [],
          compilerQualityTier: tier,
        },
      ],
      figures: [],
    };
  }

  const context: NewsContextItem[] = [
    ...insights.keyClaims.map((claim): NewsContextItem => ({
      type: 'news_context',
      refs: [ref],
      country: null,
      claim,
      mechanism: null,
      confidence: null,
      source: w.domain,
      date: w.publishedDate,
      topics: insights.topics,
      compilerQualityTier: tier,
    })),
    ...insights.economicDrivers.map((driver): NewsContextItem => ({
      type: 'news_context',
      refs: [ref],
      country: null,
      claim: driver.driver,
      mechanism: driver.mechanism,
      confidence: driver.confidence,
      source: w.domain,
      date: w.publishedDate,
      topics: insights.topics,
      compilerQualityTier: tier,
    })),
  ];

  // Only figures newsExtract.ts already confirmed are textually present in the real article
  // (see contracts.ts's ImportantFigure/textPresenceVerified doc) become StatisticItems — an
  // unverified one was already dropped upstream, at extraction time, not here.
  const figures: StatisticItem[] = insights.importantFigures
    .filter(f => f.textPresenceVerified)
    .map(f => {
      const numeric = Number(f.value.replace(/[^0-9.-]/g, ''));
      return {
        type: 'statistic' as const,
        refs: [ref],
        // newsExtract.ts already resolved this through resolveCountry() — null here means the
        // model genuinely couldn't tell, not that this code declined to look (see
        // ImportantFigure's own doc comment).
        country: f.country,
        // f.metric itself is left untouched upstream (ImportantFigure keeps it "as-written",
        // same contract as `value`) — resolution happens here, at the compiled view, which is
        // the layer whose job is producing something comparable. Resolved -> the real hub slug,
        // so this item can match/rank/dedupe/conflict against canonical DataEvidence exactly
        // like a hub-derived StatisticItem. Unresolved -> the source's own label, preserved
        // verbatim: still fully usable for display/citation/synthesis, and still able to
        // dedupe/conflict against ANOTHER unresolved item with the same exact label (two sources
        // agreeing or disagreeing on the same non-hub figure is real signal), but the raw label
        // will never coincidentally collide with a real hub slug string, so it can never be
        // silently treated as equivalent to canonical hub data or earn canonical relevance
        // credit in statisticRelevance() below.
        indicator: resolveIndicator(f.metric) ?? f.metric,
        period: f.period,
        value: numeric,
        unit: f.value.includes('%') ? '%' : 'unspecified',
        valueType: 'actual', // simplification, documented on StatisticItem — news figures aren't
        // classified actual/estimate/projection this pass
        transformation: null,
        compilerQualityTier: tier,
      };
    })
    .filter(item => Number.isFinite(item.value));

  return { context, figures };
}

// ── Deduplicate: exact-match only, never semantic — see the plan's stated scope ─────────────

function statKey(item: StatisticItem): string {
  return [item.country ?? '', item.indicator.toLowerCase(), item.period, item.unit, item.valueType, item.transformation ?? 'raw'].join('|');
}

const VALUE_TOLERANCE_RELATIVE = 5e-3; // 0.5% — rounding-noise tolerance, not a real disagreement

function withinTolerance(values: number[]): boolean {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const scale = Math.max(Math.abs(max), Math.abs(min), 1);
  return (max - min) / scale <= VALUE_TOLERANCE_RELATIVE;
}

/* Groups by exact (country, indicator, period, unit, valueType, transformation) — deliberately
 * NOT metric+period alone, which would false-flag e.g. CPI vs. GDP-deflator inflation, or an
 * annual vs. a monthly figure, as the same fact. Within a group: if every value agrees (within
 * tolerance), it is a genuine duplicate — merge refs, keep the highest-tier item's other fields.
 * If values disagree beyond tolerance, it is a real contradiction — still merge into one
 * representative (highest tier) for `keyFacts`, but also emit an EvidenceContradiction carrying
 * every disagreeing item so the synthesizer (and a human) can see the disagreement, not just the
 * winner. */
function compileStatistics(raw: StatisticItem[]): { items: StatisticItem[]; contradictions: EvidenceContradiction[] } {
  const groups = new Map<string, StatisticItem[]>();
  for (const item of raw) {
    const key = statKey(item);
    const arr = groups.get(key);
    if (arr) arr.push(item);
    else groups.set(key, [item]);
  }

  const items: StatisticItem[] = [];
  const contradictions: EvidenceContradiction[] = [];
  for (const group of groups.values()) {
    const winner = group.reduce((best, cur) => (TIER_RANK[cur.compilerQualityTier] > TIER_RANK[best.compilerQualityTier] ? cur : best));
    const refs = [...new Set(group.flatMap(g => g.refs))];
    items.push({ ...winner, refs });

    const values = group.map(g => g.value);
    if (group.length > 1 && !withinTolerance(values)) {
      contradictions.push({
        description: `${winner.indicator} for ${winner.country ?? 'an unspecified country'} in ${winner.period} is reported differently across sources.`,
        items: group,
      });
    }
  }
  return { items, contradictions };
}

/* Exact claim-text match only (trimmed, case-normalized) — real semantic near-duplicate detection
 * (two outlets covering the same story in different words) is out of scope for this pass; the
 * codebase's existing news dedup is exact-ID only, real semantic dedup isn't deterministically
 * doable, and adding a model just for this cuts against the spec's own "no additional LLM agents
 * unless deterministic code genuinely cannot do it." On a match, prefer the entry that HAS a
 * mechanism (richer) over one that doesn't, then the higher tier; refs from every match merge. */
function dedupeNewsContext(items: NewsContextItem[]): NewsContextItem[] {
  const byKey = new Map<string, NewsContextItem>();
  for (const item of items) {
    const key = item.claim.trim().toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const preferred =
      Boolean(item.mechanism) !== Boolean(existing.mechanism)
        ? (item.mechanism ? item : existing)
        : TIER_RANK[item.compilerQualityTier] > TIER_RANK[existing.compilerQualityTier]
          ? item
          : existing;
    const refs = [...new Set([...existing.refs, ...item.refs])];
    byKey.set(key, { ...preferred, refs });
  }
  return [...byKey.values()];
}

// ── Rank relevance ───────────────────────────────────────────────────────────────────────

function statisticRelevance(item: StatisticItem, intent: ResearchIntent): number {
  let score = 0;
  if (item.country && intent.countries.includes(item.country)) score += 2;
  if (intent.indicators.some(i => i.toLowerCase() === item.indicator.toLowerCase())) score += 2;
  return score;
}

function newsContextRelevance(item: NewsContextItem, intent: ResearchIntent): number {
  let score = 0;
  if (item.country && intent.countries.includes(item.country)) score += 2;
  const keywords = intent.newsKeywords.map(k => k.toLowerCase());
  if (keywords.length && item.topics.some(t => keywords.some(k => t.toLowerCase().includes(k) || k.includes(t.toLowerCase())))) score += 1;
  if (item.mechanism) score += 1; // a driver is inherently more analytically useful than a bare claim
  return score;
}

function rankAndTruncate<T extends { compilerQualityTier: CompilerQualityTier }>(
  items: T[],
  relevance: (item: T) => number,
  max: number,
): T[] {
  return [...items]
    .sort((a, b) => {
      const rel = relevance(b) - relevance(a);
      if (rel !== 0) return rel;
      return TIER_RANK[b.compilerQualityTier] - TIER_RANK[a.compilerQualityTier];
    })
    .slice(0, max);
}

// ── Gaps — deterministic, from evidence metadata, never model-generated (Stage C reads this) ──

function computeGaps(pkg: EvidencePackage): EvidenceLimitation[] {
  return pkg.misses.map(m => ({ reason: m.detail, relatedRefs: [] }));
}

// ── analysisGoal — a short, deterministic restatement of what the answer needs to explain ────

function buildAnalysisGoal(intent: ResearchIntent): string {
  const indicators = intent.indicators.length ? intent.indicators.join(', ') : 'the requested indicator';
  const countries = intent.countries.length ? intent.countries.join(', ') : 'the region';
  if (intent.questionType === 'comparison') {
    return `Explain the divergence in ${indicators} across ${countries} and the likely mechanisms behind it.`;
  }
  if (intent.questionType === 'news') {
    return `Explain recent developments for ${countries} and how they relate to the underlying economics.`;
  }
  return `Explain the trend in ${indicators} for ${countries} and the likely drivers behind it.`;
}

// ── The compiler itself ─────────────────────────────────────────────────────────────────

/* Builds the task-pane-facing evidence note (Stage C/E) from the compiler's OWN output — never
 * from anything the synthesis model says, so its count/content can never drift from what the
 * compiler actually knows. `summary` is a short, generic inline line (deliberately not per-item
 * detail — that stays in `limitations`, for a collapsible UI). Contradictions are folded in
 * alongside gaps: an unreconciled disagreement between sources is exactly as much a limitation on
 * confidence as a retrieval miss is. */
export function buildEvidenceNote(compiled: CompiledEvidence): EvidenceNote {
  const contradictionLimitations: EvidenceLimitation[] = compiled.contradictions.map(c => ({
    reason: c.description,
    relatedRefs: [...new Set(c.items.flatMap(item => item.refs))],
  }));
  const limitations = [...compiled.gaps, ...contradictionLimitations];
  if (!limitations.length) return { summary: '', limitations: [] };
  return {
    summary: `Evidence note: ${limitations.length} evidence limitation${limitations.length === 1 ? '' : 's'} — some information could not be fully confirmed or reconciled.`,
    limitations,
  };
}

export function compileEvidence(intent: ResearchIntent, plan: ResearchPlan, pkg: EvidencePackage): CompiledEvidence {
  const rawStatistics: StatisticItem[] = pkg.data.flatMap(d => normalizeDataSeries(d, intent));
  const rawNewsContext: NewsContextItem[] = pkg.news.map(normalizeNewsItem);

  const webNormalized = (pkg.web ?? []).map(normalizeWebItem);
  for (const { context, figures } of webNormalized) {
    rawNewsContext.push(...context);
    rawStatistics.push(...figures);
  }

  const { items: statistics, contradictions } = compileStatistics(rawStatistics);
  const newsContext = dedupeNewsContext(rawNewsContext);

  const driverItems = newsContext.filter(item => item.mechanism !== null);
  const contextOnlyItems = newsContext.filter(item => item.mechanism === null);

  return {
    question: plan.question,
    analysisGoal: buildAnalysisGoal(intent),
    keyFacts: rankAndTruncate(statistics, item => statisticRelevance(item, intent), MAX_KEY_FACTS),
    driverEvidence: rankAndTruncate(driverItems, item => newsContextRelevance(item, intent), MAX_DRIVER_ITEMS),
    // Knowledge Hub placeholder (deferred per the plan) — always empty this pass; MAX_CONCEPTS
    // exists as the enforced cap for whenever concept items are actually populated.
    economicConcepts: [],
    externalEvidence: rankAndTruncate(contextOnlyItems, item => newsContextRelevance(item, intent), MAX_EXTERNAL_FINDINGS),
    contradictions: contradictions.slice(0, MAX_CONTRADICTIONS),
    gaps: computeGaps(pkg),
    caveats: pkg.caveats,
    // plan (the validated ResearchPlan) is already this function's own parameter — MAX_PLAN_STEPS
    // (config.ts) already bounds `steps` to 8, so no separate cap is needed here. Filtered for
    // the same reason toFilteredStringArray (plan.ts) exists: a step's `why` is model output too,
    // and an empty one is possible even though coerceStep requires it be non-empty at parse time.
    investigationNotes: plan.steps.map(s => s.why).filter(why => why.trim().length > 0),
  };
}
