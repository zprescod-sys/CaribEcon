/* The grounding gate (ARCHITECTURE.md §2.6, Phase 2). Pure code. Always runs. Free. Cannot fail
 * open — there is no code path in this module that can be unavailable the way a model call can.
 *
 * It checks a synthesized ResearchAnswer against the EvidencePackage that produced it and
 * reports what the answer asserts that the evidence does not support. It does not rewrite or
 * drop anything itself — verify() (Phase 4) derives a VerificationVerdict from this result plus
 * the optional model audit, and that derivation is what actually narrows or withholds a claim.
 *
 * PHASE 2 SCOPE, STATED EXPLICITLY: §2.6 specifies eleven checks (see the GroundingCheck union
 * in contracts.ts). Checks 1 (ref existence), 2 (URL allowlist), 3 (slug/country tokens),
 * 4 (figure reconciliation), 5 (wrong calculation), 6 (unstated number), 7 (news body claim),
 * 9 (cross-currency comparison), and 10 (coverage honesty) are implemented here. Checks 8 (quote
 * check) and 11 (web figure reconciliation) are deliberately deferred — both are `W:` web-evidence
 * rules, and nothing populates web evidence until Phase 3's Tavily integration; there is nothing
 * for them to check yet. This module is NOT YET wired into research()
 * — research.ts still returns its stubVerdict until enough checks exist to be a meaningful gate.
 *
 * What this gate genuinely cannot check, even once all eleven checks exist — put this list
 * here, not just in the architecture doc, because a safety gate's worst failure mode is a
 * reader assuming it covered more than it did:
 *   - Whether a causal claim is TRUE. Code can detect causal language and require hedging; it
 *     cannot adjudicate direction.
 *   - Whether evidence SELECTION is representative — cherry-picking a favourable window is
 *     invisible to a gate that only checks what was cited.
 *   - Whether a forecast or scenario is reasonable. There is no evidence for a counterfactual.
 *   - Whether a web source is credible. Only that the domain matches what Tavily returned.
 *   - Whether the answer answers the question.
 */
import { getCountries, getIndicatorMeta } from '../indicators.js';
import { evidenceId, type DataEvidence, type EvidencePackage } from '../askTools.js';
import { yoy_change, pp_change, period_average } from '../calculations.js';
import { calculationForUnit } from '../excelOutputs.js';
import type { EvidenceRef, GroundingResult, GroundingViolation, ResearchAnswer } from './contracts.js';

/* The set of refs this package can actually back a claim with. Read off evidenceMeta rather
 * than re-deriving `D:${evidenceId(...)}` / `N:${id}` from pkg.data/pkg.news separately —
 * evidenceMeta is already, by construction (askTools.ts), "one entry per unique EvidenceRef
 * pulled into this package" (§2.5), so it is the single source of truth for "what's in here,"
 * and stays correct automatically once Phase 3 starts populating W: entries too. */
function knownRefs(pkg: EvidencePackage): ReadonlySet<EvidenceRef> {
  return new Set(pkg.evidenceMeta.map(m => m.ref));
}

/* Check 1 (§2.6): "every Claim.refs[] and StatedFigure.ref resolves. Set membership." Both
 * arrays are checked per claim and deduped to one violation per (claim, missing ref) pair —
 * a claim commonly repeats the same ref in both places, and that is one offense, not two. */
function checkRefExistence(answer: ResearchAnswer, known: ReadonlySet<EvidenceRef>): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const claim of answer.claims) {
    const cited = new Set<EvidenceRef>([...claim.refs, ...claim.figures.map(f => f.ref)]);
    for (const ref of cited) {
      if (!known.has(ref)) {
        violations.push({
          claimId: claim.id,
          check: 'ref_existence',
          detail: `Claim "${claim.id}" cites ${ref}, which is not in the evidence package.`,
        });
      }
    }
  }
  return violations;
}

/* Check 2 (§2.6): "every URL in prose, normalised (lowercase host, strip trailing slash, strip
 * utm_*), must === a DataEvidence.sourceUrl, NewsEvidence.url, or WebEvidence.url. This is the
 * check api/research.ts has never had." Comparison is exact string equality on the normalised
 * form — never substring or domain-only, so a model citing a real domain with a fabricated path
 * still fails. */
function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  const query = url.searchParams.toString();
  return `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`;
}

/* Known sources are already only ever real retrieval URLs (DataEvidence/NewsEvidence/WebEvidence
 * come from the hub or Tavily, never from a model) — this is the allowlist, not something the
 * gate builds from prose. */
function knownUrls(pkg: EvidencePackage): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const d of pkg.data) {
    const n = normalizeUrl(d.sourceUrl);
    if (n) urls.add(n);
  }
  for (const item of pkg.news) {
    const n = normalizeUrl(item.url);
    if (n) urls.add(n);
  }
  for (const w of pkg.web ?? []) {
    const n = normalizeUrl(w.url);
    if (n) urls.add(n);
  }
  return urls;
}

// Trailing sentence punctuation is common right after a URL in prose ("...at https://x.com.")
// and is never part of the URL itself; markdown/quote wrappers are stripped the same way.
const URL_PATTERN = /\bhttps?:\/\/[^\s)\]}"'<>]+/gi;
function extractUrls(text: string): string[] {
  return (text.match(URL_PATTERN) ?? []).map(u => u.replace(/[.,;:!?)\]}]+$/, ''));
}

function checkUrlAllowlist(answer: ResearchAnswer, allowed: ReadonlySet<string>): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const claim of answer.claims) {
    for (const rawUrl of extractUrls(claim.text)) {
      const normalized = normalizeUrl(rawUrl);
      if (normalized === null || !allowed.has(normalized)) {
        violations.push({
          claimId: claim.id,
          check: 'url_allowlist',
          detail: `Claim "${claim.id}" states a URL (${rawUrl}) that is not among the retrieved sources.`,
        });
      }
    }
  }
  return violations;
}

/* Check 3 (§2.6): "any hub slug or full country name in prose must be in the retrieved set. Skip
 * bare 2-letter codes; too noisy." Matched against the WHOLE hub's vocabulary — every country,
 * every indicator slug — not just this package's contents, which is what catches a model naming
 * a country or indicator it was never given evidence for, rather than only checking spelling.
 *
 * Framing claims are exempt. By construction (contracts.ts) they are the one claim type allowed
 * empty refs/figures, and in practice they are frequently the claim that HONESTLY NAMES an
 * absence ("no inflation data was retrieved for any of the 19 economies") — flagging that would
 * penalise exactly the disclosure this pipeline wants. A real capture in
 * fixtures/askCaptures.json ("out_of_hub_country") does exactly this. Non-framing claims already
 * require at least one real ref (synthesize.ts's coerceClaim), so this check is only reachable
 * there for a token the claim mentions WITHOUT backing it by a ref — e.g. a comparative aside
 * naming a country that was never retrieved. */
const ALL_COUNTRIES = getCountries();
const ALL_INDICATOR_SLUGS = getIndicatorMeta().map(m => m.slug);

function tokenPattern(literal: string): RegExp {
  // "&" in a country name (e.g. "Trinidad & Tobago") must also match the "and" a model
  // naturally writes in prose.
  const parts = literal.split(/\s*&\s*/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b${parts.join('\\s*(?:&|and)\\s*')}\\b`, 'i');
}

const COUNTRY_PATTERNS = ALL_COUNTRIES.map(c => ({ code: c.code, pattern: tokenPattern(c.name) }));
const SLUG_PATTERNS = ALL_INDICATOR_SLUGS.map(slug => ({ slug, pattern: tokenPattern(slug) }));

function retrievedCountryCodes(pkg: EvidencePackage): ReadonlySet<string> {
  const codes = new Set<string>();
  for (const d of pkg.data) codes.add(d.country);
  for (const item of pkg.news) if (item.country !== 'ALL') codes.add(item.country);
  return codes;
}

function checkSlugTokens(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  const retrievedCountries = retrievedCountryCodes(pkg);
  const retrievedIndicators = new Set(pkg.data.map(d => d.indicator));
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    if (claim.type === 'framing') continue;

    for (const { code, pattern } of COUNTRY_PATTERNS) {
      if (!retrievedCountries.has(code) && pattern.test(claim.text)) {
        violations.push({
          claimId: claim.id,
          check: 'slug_tokens',
          detail: `Claim "${claim.id}" names a country (${code}) that was not retrieved for this package.`,
        });
      }
    }
    for (const { slug, pattern } of SLUG_PATTERNS) {
      if (!retrievedIndicators.has(slug) && pattern.test(claim.text)) {
        violations.push({
          claimId: claim.id,
          check: 'slug_tokens',
          detail: `Claim "${claim.id}" names an indicator ("${slug}") that was not retrieved for this package.`,
        });
      }
    }
  }
  return violations;
}

// Violation details are read by a human debugging a rejected claim — round away binary
// floating-point noise (0.1 - 0.47 = -0.36999999999999994) rather than surfacing it verbatim.
function fmt(n: number): string {
  return Number(n.toFixed(6)).toString();
}

/* Number matching, used by check 4 below. A model writes 16.3 for 16.326, "1.75 bn" for
 * 1,750,288 in a "US$ mn" series, "about 62%" for 62.3. Precision is read off the written
 * string, not assumed, which is what makes both "16.3" and "16.33" checkable. */
export function figureMatches(stated: number, actual: number, asWritten: string): boolean {
  const decimals = asWritten.match(/\.(\d+)/)?.[1].length ?? 0;
  if (Number(actual.toFixed(decimals)) === Number(stated.toFixed(decimals))) return true;
  return Math.abs(stated - actual) <= Math.abs(actual) * 1e-3; // "about", "~", "roughly"
}

/* Check 4 (§2.6): "calculation === null -> look up the point. Otherwise re-run the registry
 * function and compare at that year. CalculationResult.inputYears gives the violation message
 * its lineage for free." Only D: figures are handled here — N: figures are forbidden outright
 * by check 7 (news is metadata-only) and W: figures have their own rule, check 11, because a
 * web page is reconciled against extracted text rather than a hub series. A ref that doesn't
 * resolve at all is check 1's job, not this one's — skip it silently here rather than double
 * report. period_average ignores figure.year (synthesize.ts's own prompt tells the model to
 * send null there, since the average is a whole-range figure, not year-specific). */
function checkFigureReconciliation(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  const byRef = new Map<string, DataEvidence>(pkg.data.map(d => [`D:${evidenceId(d.country, d.indicator)}`, d]));
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    for (const figure of claim.figures) {
      if (!figure.ref.startsWith('D:')) continue;
      const series = byRef.get(figure.ref);
      if (!series) continue;

      if (figure.calculation === null) {
        const point = series.points.find(p => p.year === figure.year);
        if (!point || point.value === null) {
          violations.push({
            claimId: claim.id,
            check: 'figure_reconciliation',
            detail: `Claim "${claim.id}" states ${figure.asWritten} for ${figure.ref} at ${figure.year}, but no retrieved value exists at that year.`,
          });
        } else if (!figureMatches(figure.value, point.value, figure.asWritten)) {
          violations.push({
            claimId: claim.id,
            check: 'figure_reconciliation',
            detail: `Claim "${claim.id}" states ${figure.asWritten} for ${figure.ref} at ${figure.year}, but the retrieved value is ${fmt(point.value)}.`,
          });
        }
        continue;
      }

      const result =
        figure.calculation === 'period_average'
          ? period_average(series.points)
          : (figure.calculation === 'yoy_change' ? yoy_change(series.points) : pp_change(series.points)).find(
              r => r.year === figure.year,
            );

      if (!result || result.value === null) {
        violations.push({
          claimId: claim.id,
          check: 'figure_reconciliation',
          detail: `Claim "${claim.id}" states a ${figure.calculation} of ${figure.asWritten} for ${figure.ref}, but re-running that calculation produces no value there.`,
        });
      } else if (!figureMatches(figure.value, result.value, figure.asWritten)) {
        violations.push({
          claimId: claim.id,
          check: 'figure_reconciliation',
          detail: `Claim "${claim.id}" states a ${figure.calculation} of ${figure.asWritten} for ${figure.ref}, but re-running it (from years ${result.inputYears.join(', ')}) gives ${fmt(result.value)}.`,
        });
      }
    }
  }
  return violations;
}

/* Check 5 (§2.6): "Wrong change-calculation — unit === '%' claimed as yoy_change is a violation
 * on its own. The gate enforces the same rule calculationForUnit already enforces
 * deterministically" (excelOutputs.ts). That function is the single source of truth for "which
 * calculation this series' unit requires" — synthesize.ts's own prompt is built from it too, so
 * a model that ignores the instruction and picks the other calculation is caught here rather
 * than only producing a confusing number downstream. Only yoy_change/pp_change are judged:
 * period_average is unit-agnostic (there is no "wrong" period_average), and calculation === null
 * is a raw value with no calculation to be wrong about — that's check 4's territory. A ref that
 * doesn't resolve to a real series is check 1's job; skip it silently here rather than double
 * report, same convention as check 4. */
function checkWrongCalculation(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  const byRef = new Map<string, DataEvidence>(pkg.data.map(d => [`D:${evidenceId(d.country, d.indicator)}`, d]));
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    for (const figure of claim.figures) {
      if (figure.calculation !== 'yoy_change' && figure.calculation !== 'pp_change') continue;
      const series = byRef.get(figure.ref);
      if (!series) continue;

      const expected = calculationForUnit(series.unit);
      if (figure.calculation !== expected) {
        violations.push({
          claimId: claim.id,
          check: 'wrong_calculation',
          detail: `Claim "${claim.id}" uses ${figure.calculation} for ${figure.ref}, but its unit ("${series.unit}") requires ${expected}.`,
        });
      }
    }
  }
  return violations;
}

/* Check 6 (§2.6): "Unstated numbers — every numeric literal in prose must be a declared figure,
 * a year in range, or a small ordinal ("three indicators"). Catches a figure stated but not
 * declared." Framing claims are exempt, same precedent as check 3 — they legitimately discuss
 * absences/context with bare numbers ("19 economies") that have no figure backing, by contract
 * design (a framing claim is the one type allowed empty refs/figures).
 *
 * The declared-figure pool is the UNION of every claim's figures across the WHOLE answer, not
 * just the current claim's own — a real capture (fixtures/askCaptures.json, "regional" category,
 * claim-4) writes "...to 134.6%..." reusing a figure that was declared back in claim-0 of the
 * SAME answer as a narrative callback, not re-declared locally. Scoping the pool to the current
 * claim only would falsely flag that legitimate reuse.
 *
 * Matching is sign-insensitive (Math.abs on both sides, via the existing figureMatches helper) —
 * a real capture ("time_series" category) writes "declining 3.88 pp" in prose with no literal
 * minus sign, while the matching StatedFigure.value is -3.88. Signed comparison would falsely
 * flag correct, idiomatic prose every time a decrease is phrased in words rather than a sign. */
const NUMBER_PATTERN = /-?\d[\d,]*\.?\d+|-?\d+/g;

/* Every point-year actually retrieved, across every series in the package — a model narrating
 * "...to 134.6% in 2017..." is stating a year, not a figure, and years are not in StatedFigure at
 * all (they live alongside figures, not as one), so they need their own exemption. */
function retrievedPointYears(pkg: EvidencePackage): ReadonlySet<number> {
  const years = new Set<number>();
  for (const d of pkg.data) for (const p of d.points) years.add(p.year);
  return years;
}

function checkUnstatedNumber(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  // The cross-claim pool (see block comment above) — built once per answer, not per claim.
  const allFigures = answer.claims.flatMap(c => c.figures);
  const years = retrievedPointYears(pkg);
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    if (claim.type === 'framing') continue;

    for (const match of claim.text.matchAll(NUMBER_PATTERN)) {
      const raw = match[0];
      const extracted = Number(raw.replace(/,/g, ''));
      // "Integer with no decimal point" means the extracted VALUE has none (0.00 is still a
      // fractional-looking figure in prose, even though 0 is mathematically a whole number) —
      // Number.isInteger on the parsed value is exactly that, deliberately not a check of
      // whether the matched substring contains a literal '.' character.
      const isInteger = Number.isInteger(extracted);

      // Small narrative counts ("19 economies", "the top 3 economies", "2 consecutive years")
      // are prose scaffolding, not data figures. 30 is comfortably above any plausible count of
      // countries/indicators/years-in-a-row this answer would ever narrate, and comfortably
      // below the smallest plausible economic figure (a growth rate, a debt ratio, a year), so
      // it separates the two cleanly without either false-positiving on real counts or
      // false-negativing on a genuinely small but real figure.
      if (isInteger && extracted >= 0 && extracted <= 30) continue;
      // A bare year the answer is narrating ("...in 2017...") is not itself a figure to reconcile
      // — check 4 already reconciles the figure that accompanies it.
      if (isInteger && years.has(extracted)) continue;

      const declared = allFigures.some(f => figureMatches(Math.abs(extracted), Math.abs(f.value), raw));
      if (!declared) {
        violations.push({
          claimId: claim.id,
          check: 'unstated_number',
          detail: `Claim "${claim.id}" states ${raw}, which is not a declared figure, a retrieved point-year, or a small count.`,
        });
      }
    }
  }
  return violations;
}

/* Check 7 (§2.6): "News-body claims — a claim refing only N: items may carry no figures and no
 * quoted run over ~5 words. You only have headlines. This makes the metadata-only rule code, not
 * a prompt." A claim is "news-only" when it cites at least one ref — refs[] or figures[].ref,
 * unioned, the same set check 1 builds — AND every one of those refs starts with 'N:'. A claim
 * that also cites a D: or W: ref is NOT news-only (it is also backed by real data or a web
 * extract), so it is exempt from both sub-checks below; that is what stops this check from
 * firing on a claim that merely mentions a news item alongside a genuine data figure. */
function isNewsOnly(claim: ResearchAnswer['claims'][number]): boolean {
  const cited = [...claim.refs, ...claim.figures.map(f => f.ref)];
  return cited.length > 0 && cited.every(ref => ref.startsWith('N:'));
}

// Straight and curly double quotes both appear in model prose. A run captured between either
// pair, split on whitespace, longer than ~5 words is treated as quoting more of an article than a
// headline could ever supply — NewsEvidence (news.ts) is headline/source/date/link only, never a
// body extract, so a long quote citing only an N: ref could only be a fabrication.
const QUOTE_PATTERN = /["“]([^"”]+)["”]/g;
const MAX_QUOTED_WORDS = 5;

// pkg is unused here — unlike checks 3-6, "news-only" is a property of the claim's own refs, not
// something that needs cross-referencing against the package. The parameter is kept anyway so
// this check has the same (answer, pkg) shape as its siblings and can be added to the
// runGroundingGate spread the same way.
function checkNewsBodyClaim(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  void pkg;
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    if (!isNewsOnly(claim)) continue;

    if (claim.figures.length > 0) {
      violations.push({
        claimId: claim.id,
        check: 'news_body_claim',
        detail: `Claim "${claim.id}" cites only news evidence but carries a figure — news evidence is headline metadata only.`,
      });
    }

    for (const match of claim.text.matchAll(QUOTE_PATTERN)) {
      const words = match[1].trim().split(/\s+/).filter(Boolean);
      if (words.length > MAX_QUOTED_WORDS) {
        violations.push({
          claimId: claim.id,
          check: 'news_body_claim',
          detail: `Claim "${claim.id}" quotes ${words.length} words ("${match[1]}") from a source cited only as headline metadata.`,
        });
      }
    }
  }
  return violations;
}

/* Check 9 (§2.6): "Cross-currency comparison — figures spanning two refs with different non-%
 * units plus a comparative token (more than|larger|vs|exceeds|times|double) → flag." A unit
 * counting as "percent-type" — and therefore always mutually comparable regardless of how it's
 * phrased — means it CONTAINS '%' anywhere, not just an exact '%' string: real captures use
 * '% of GDP' as a level unit throughout (a debt-to-GDP ratio), and two figures in that unit are
 * exactly as comparable as two in bare '%'. Only a pair of genuinely non-percent units (e.g.
 * 'US$ mn' vs 'GY$ per US$' — a level in one currency vs an exchange rate in another) is what
 * this check exists to catch. Units alone are never the violation — citing two currencies side
 * by side is fine; it's the comparative FRAMING ("X exceeds Y") implying direct comparability
 * that is the problem, so both conditions must hold together. */
const PERCENT_UNIT = (unit: string) => unit.includes('%');
const COMPARATIVE_TOKEN = /more than|larger|\bvs\.?\b|exceeds|\btimes\b|double/i;

function checkCrossCurrencyComparison(answer: ResearchAnswer): GroundingViolation[] {
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    const nonPercentUnits = new Set(claim.figures.map(f => f.unit).filter(u => !PERCENT_UNIT(u)));
    if (nonPercentUnits.size < 2) continue;
    if (!COMPARATIVE_TOKEN.test(claim.text)) continue;

    violations.push({
      claimId: claim.id,
      check: 'cross_currency_comparison',
      detail: `Claim "${claim.id}" uses comparative language across incompatible units (${[...nonPercentUnits].join(', ')}).`,
    });
  }
  return violations;
}

/* Check 10 (§2.6): "Coverage honesty — a year named outside that ref's retrieved range →
 * year_outside_coverage." (contracts.ts's GroundingCheck union spells the check's own name
 * 'coverage_honesty' — 'year_outside_coverage' in the architecture doc is the prose description
 * of what it catches, not the literal check value; used the same way every other check here uses
 * its GroundingCheck union name.) A figure with figure.year === null is never judged — that's
 * period_average, which is a whole-range figure with no single year to be outside of. A ref that
 * doesn't resolve is check 1's territory; skip it silently, same convention as checks 4/5. */
function checkCoverageHonesty(answer: ResearchAnswer, pkg: EvidencePackage): GroundingViolation[] {
  const byRef = new Map<string, DataEvidence>(pkg.data.map(d => [`D:${evidenceId(d.country, d.indicator)}`, d]));
  const violations: GroundingViolation[] = [];

  for (const claim of answer.claims) {
    for (const figure of claim.figures) {
      if (figure.year === null) continue;
      const series = byRef.get(figure.ref);
      if (!series || series.points.length === 0) continue;

      const years = series.points.map(p => p.year);
      const min = Math.min(...years);
      const max = Math.max(...years);
      if (figure.year < min || figure.year > max) {
        violations.push({
          claimId: claim.id,
          check: 'coverage_honesty',
          detail: `Claim "${claim.id}" names ${figure.year} for ${figure.ref}, but the retrieved range for that series is ${min}–${max}.`,
        });
      }
    }
  }
  return violations;
}

export function runGroundingGate(answer: ResearchAnswer, evidence: EvidencePackage): GroundingResult {
  const violations: GroundingViolation[] = [
    ...checkRefExistence(answer, knownRefs(evidence)),
    ...checkUrlAllowlist(answer, knownUrls(evidence)),
    ...checkSlugTokens(answer, evidence),
    ...checkFigureReconciliation(answer, evidence),
    ...checkWrongCalculation(answer, evidence),
    ...checkUnstatedNumber(answer, evidence),
    ...checkNewsBodyClaim(answer, evidence),
    ...checkCrossCurrencyComparison(answer),
    ...checkCoverageHonesty(answer, evidence),
  ];
  return { ran: true, violations };
}
