# Deep Dive refinement plan

**Status:** planned after default model/prompt lock, end-to-end latency validation, and
verification hardening. This document converts the current Deep Dive material into an executable
plan; it does not authorize a new architecture or a standalone Country Comparison endpoint.

## Product boundary

Deep Dive is a concise, decision-ready economic briefing inside Excel. Ask CaribEcon is the
open-ended research surface; Deep Dive must not expand into Ask-level analysis. It starts from an
explicit country, up to three indicators, and a period; it is not a second free-form research
agent.

The implemented core is `POST /api/deepdive`: validated picker intent, deterministic series
retrieval, approved calculations, chart/workbook plans, source metadata, and Office.js rendering.
It is deliberately model-free today. Preserve that working path throughout this refinement.

## Responsibilities

| Report element | Owner |
| --- | --- |
| Title, metadata, indicator table, trend chart | Deterministic code |
| Regional comparison and comparability decision | Deterministic code |
| Recent-news candidate retrieval | Deterministic code |
| Headline, 3-4 key takeaways, regional interpretation, news relevance | Deep Dive Analyst, after deterministic retrieval |
| Sources/evidence, citations, workbook layout, Excel formatting | Deterministic code |

The analyst does not research, calculate figures, compose URLs, choose cell addresses, or return
formatting instructions. It receives only validated observations, deterministic calculations,
comparison results, recent-news candidates, and stable evidence references. Code owns facts and
execution; the analyst supplies bounded judgment.

## Report shape

```text
CaribEcon
<Country> Economic Deep Dive · <Primary indicator> · <Period>
Updated <retrieval date>

Key indicators | Trend chart
Regional comparison | Key takeaways
Recent developments
Sources / evidence
```

The layout should follow this hierarchy and content density, not any supplied color scheme. The
primary indicator drives the headline, main chart, regional comparison, and news-relevance test.
The first selected indicator is the primary indicator initially; indicators two and three are
context indicators. This avoids new picker complexity while retaining the existing three-indicator
limit.

## Comparison and news rules

- Direct regional comparison is allowed only where units and coverage are comparable. For example,
  growth rates can be compared; local-currency level GDP values cannot. If no deterministic
  transformation or standard metric is available, suppress the comparison and state why.
- News retrieval produces a bounded shortlist of roughly five candidate summaries, filtered by
  country, recency, and primary-indicator/topic relevance. The analyst selects one to three only
  when an identifiable economic mechanism plausibly connects the event to the primary indicator;
  otherwise it omits the section.
- A selected news item is expressed as event, connection to indicator, and implication, not as an
  ungrounded generic summary. `N:` news remains metadata-only; article-derived assertions require
  separately retrieved `W:` evidence.

## Analyst contract and verification handoff

Key Takeaways normally contains three items, occasionally four. Together they answer: what
happened, why it happened, and what it means. They remain concise and evidence-linked rather than
becoming a second Ask-style analysis.

The future Deep Dive Analyst returns structured narrative only, for example:

```json
{
  "headline": "string",
  "headlineRefs": ["D:country:indicator"],
  "keyTakeaways": [{ "text": "string", "evidenceRefs": ["D:country:indicator"] }],
  "regionalInsight": { "text": "string", "evidenceRefs": ["D:country:indicator"] },
  "news": [{ "articleId": "string", "whyItMatters": "string", "evidenceRefs": ["N:article-id"] }]
}
```

The exact TypeScript contract should reuse the existing evidence-reference and deterministic
publication principles, rather than expose workbook coordinates. Every analyst statement follows
the hardened verification contract before rendering; failing narrative is withheld while the
deterministic table, chart, sources, and caveats remain available.

## Delivery sequence

1. Complete default model/prompt lock and latency validation for Ask.
2. Apply the targeted verification hardening and observability from
   `docs/VERIFICATION_AUDIT.md`.
3. Extend the deterministic Deep Dive package with primary/context indicator semantics,
   comparability output, and bounded news candidates. Keep the current picker workflow usable.
4. Define and test the Deep Dive Analyst's structured output against that package. Add no model
   retrieval loop and no model-owned layout.
5. Render the report deterministically in Excel, then perform real Excel-host smoke tests for
   layout, charts, sources, error/narrowing states, and omission of irrelevant news.
6. Inspect the existing task-pane state and Ask session/context patterns, then add the Deep Dive
   completion state, deterministic follow-ups, and one-way handoff into Ask.
7. Perform real Excel-host smoke tests for report layout, completion/reset behavior, Ask handoff,
   error/narrowing states, and omission of irrelevant news. Move to UX/demo polish only after
   these contracts are stable.

## Post-generation task-pane experience

After a Deep Dive has rendered successfully in Excel, the task pane transitions out of the picker
and into a compact completion state. It summarizes the generated briefing (country, primary
indicator, selected period, and a short report status or headline), offers relevant follow-ups, and
provides an explicit route into Ask CaribEcon. Adapt this state to the existing CaribEcon task-pane
design system; it is not a literal new design or a second chat UI.

The completion state provides a small close/reset control and a clear **Generate another Deep
Dive** action. Either returns to the existing picker/generation state according to current
navigation conventions. Neither action deletes or alters the already-rendered workbook report.

## Excel number-format consistency

Deep Dive values and the add-in's **Insert as formulas** path must share the same unit-aware Excel
number-format policy: years as whole numbers; hub percentages as literal percent suffixes (without
Excel multiplying already-percent values by 100); whole-person and bare-currency values with
thousands separators; exchange rates at their required precision; and other levels with the
defined decimal precision. Reuse the existing shared `numberFormatForUnit()` policy rather than
duplicating formatting rules in the task pane or the CE custom-function code.

Excel custom functions such as `CE.GDP`, `CE.INDICATOR`, and `CE.SERIES` can return values but
cannot set the format of a cell where a user types a formula directly. The add-in applies the
shared format whenever it inserts CE formulas into a worksheet. Directly entered CE formulas keep
the user's chosen Excel cell format; provide clear reference guidance where needed, but do not
claim that a custom function can override it.

## Deterministic follow-up suggestions

Suggested questions are generated deterministically from the validated Deep Dive package, not
invented afresh by an LLM. Aim for approximately three useful suggestions, using only question
families whose required package data exists:

| Question family | Example | Required context |
| --- | --- | --- |
| Driver / mechanism | “What's driving Guyana's GDP growth?” | Country and primary indicator |
| Regional | “How does this compare with regional peers?” | Published, comparable regional comparison |
| Outlook / risk | “What could change this outlook?” | A report with validated outlook, risk, or caveat context |
| Context indicator | “How does inflation affect this picture?” | At least one selected context indicator |
| Recent development | “How could <development> affect GDP growth?” | An included, relevant recent development |
| Caveat | “What are the main limitations or risks in this analysis?” | Published caveats or suppressed-section explanations |

Do not fill space with unavailable topics: omit the regional question if comparison was suppressed
for lack of comparability, the news question if no development was included, and the context
question when only the primary indicator was selected. Template selection must be stable for an
identical validated package.

## Deep Dive to Ask handoff

The completion state is a bridge, not a conversation view. Selecting a suggestion or submitting
the **Ask about this Deep Dive** input transitions the user into the existing Ask CaribEcon pane.
The flow is:

```text
Generate Deep Dive → report rendered in Excel → completion state
  → suggested or typed question → Ask CaribEcon → normal conversation
```

The handoff starts or selects the appropriate Ask conversation using existing application patterns,
passes the Deep Dive context, and sends the selected or typed question as its first Ask message.
Do not render messages underneath the Deep Dive completion view; all subsequent conversation stays
in Ask CaribEcon.

Before implementation, inspect the current task-pane navigation, Ask conversation state, and
request-context architecture. Reuse the smallest compatible structured handoff rather than add a
parallel navigation or session framework. The context should be limited to the Deep Dive's country,
primary and context indicators, selected period, validated observations and approved calculations,
regional-comparison result, included developments, evidence references, headline/takeaways, and
caveats or suppressed sections.

Ask treats this as starting context only. It must continue its normal retrieval, grounding,
evidence, citation, verification, cancellation, and error-handling rules for every subsequent
question. Deep Dive context improves referential understanding; it is never a bypass around Ask's
evidence controls, and the rendered workbook itself is not pasted into the conversation.

## UX state model

Inspect the existing task-pane state model first and extend it minimally. The required visible
states and transitions are:

| State | Purpose | Exit |
| --- | --- | --- |
| Picker | Select country, indicators, and period | Generate → generating |
| Generating | Preserve existing loading and cancellation behavior while the package/report is built | Success → completion; failure or narrowing → error/narrowing |
| Completion | Show concise report summary, deterministic suggestions, Ask input, and reset controls | Ask action → Ask; reset/close/new report → picker |
| Error / narrowing | Present the existing recoverable error or insufficient-data path | Revise selection or reset → picker |
| Ask transition | Create/select Ask context and submit the first question | Existing Ask conversation behavior |

No reset path deletes the completed worksheet. Preserve the existing cancellation and error
semantics throughout these transitions.

## Explicit non-goals

- No standalone near-term Country Comparison endpoint; Deep Dive owns comparison behavior.
- No automatic insertion of irrelevant news just because a report has a news section.
- No comparison of incompatible local-currency levels.
- No model-generated figures, citations, formulas, cell coordinates, or formatting.
- No model-based claims-audit agent unless measured evidence later establishes a gap that
  deterministic verification cannot address.
- No Deep Dive-specific chat transcript or parallel task-pane navigation/session framework.
