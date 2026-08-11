# CaribEcon Excel Buildathon Engineering Plan

This file retains its earlier Ask CaribEcon filename for continuity. It is now the canonical plan for the whole Excel add-in.

## Purpose and MVP boundary

Build a trustworthy Caribbean economic-intelligence experience inside Excel.

The buildathon MVP has two primary structured workflows:

1. Single Country Deep Dive
2. Country Comparison, initially Trinidad and Tobago and Guyana

Both workflows ship in two build steps within their own phase (section 9): a deterministic core first — validated intent, retrieval, compute, and native Excel output, no agent involvement required — then a tightened agentic layer on top of it: one merged Planning+Context Selection call that decomposes the request and judges news relevance, deterministic compute and synthesis, and one merged Verification call that checks both computed-value evidence support and the written narrative's claims, with a single retry and an escalate path to a Human Review Gate. This is a deliberately tightened version of the fuller multi-agent pipeline in the project's retired `CaribEcon_Build_Worflow.pdf` (five separate agent roles, two independent verification passes, up to two retries each) — same "verifier that rejects and re-routes" property, roughly half the model calls and failure surface. The deterministic core is not a lesser fallback kept around for safety — section 7 makes it the graceful-degradation path for every agent role in the pipeline, so one provider outage narrows the output rather than breaking it.

Ask CaribEcon is a bounded natural-language retrieval and synthesis feature. It reuses the same Nebius/MiniMax provider adapters built for the two structured workflows — the plumbing, not the role functions — but gets none of Deep Dive/Comparison's Planning+Context Selection or Verification role functions; it stays the lighter Interpreter → deterministic retrieval → Synthesizer shape, plus its own narrow, optional Tavily web-evidence fallback (section 6, section 9 Phase 5b). It is not a general research agent and does not replace the structured workflows.

The MVP is complete when an analyst can produce editable Excel outputs for both primary workflows through the tightened pipeline above — plan, verified evidence, verified narrative, native output, and a working escalation path — with deterministic retrieval, calculations, charts, and row-level provenance throughout. Ask CaribEcon then reuses those foundations. If the agentic layer threatens the deadline, its own deterministic core is a complete, demoable fallback — ship that and add the agentic layer after, rather than risk both. Ask's own optional agentic retriever (Phase 6) and streaming remain optional after the boundary above.

## 1. Non-negotiable principles

### CaribEcon owns the truth

All economic figures, data types, vintages, sources, URLs, country metadata, and news provenance originate in the controlled CaribEcon Data Hub and News Hub. A model may never substitute training knowledge for controlled evidence.

    Natural-language request
              |
         AI interpretation             optional
              |
      validated structured intent
              |
    CaribEcon tools and compute        deterministic
              |
    evidence, lineage, chart/workbook plan
              |
      AI explanation of evidence        optional
              |
      Office.js tables and charts       deterministic

AI interprets and explains. CaribEcon retrieves and calculates. Excel renders.

### Shared does not mean mandatory

Nebius and MiniMax are shared server-side capabilities for natural-language Excel workflows. They are not required for Browse, the seven CE functions, explicit selection, deterministic calculations, table insertion, or chart rendering. Those paths must remain usable when AI providers are disabled.

### Buildathon guardrails

- api/research.ts is frozen and remains deployable as the legacy rollback endpoint.
- Serverless code must stay nodenext-safe: explicit .js specifiers, JSON import attributes, and no dataHub.ts import in a Vercel function.
- Do not add React, a backend framework, general-purpose or always-on web search, article-body scraping, automatic causal inference, a generic agent framework, Word/PowerPoint work, or CariBench work. The one exception is the narrowly bounded, off-by-default Tavily web-evidence fallback described in sections 3, 5, 6, 8, and 9 — it fires at most once per Ask CaribEcon request, only for a news/context question with a confirmed News Hub miss, and it never supplies indicator or comparison figures. It is not general web search and the two structured workflows never call it.
- A polished deterministic workflow is preferable to an unstable agentic feature.

## 2. Existing foundation and status

Reuse rather than rebuild:

| Component | Plan treatment |
| --- | --- |
| src/lib/indicators.ts | Reuse for server-side data reads. |
| src/lib/news.ts | Reuse for metadata evidence only. |
| src/lib/askTools.ts | Reuse and harden; do not duplicate it. |
| api/research.ts | Freeze as rollback only, then delete once Phase 5 is stable — section 7, section 9. |
| api/indicator.ts and api/snapshot.ts | Preserve unchanged. |
| excel-addin/src/shared/hub.js | Preserve for Browse and custom functions. |
| excel-addin/src/taskpane | Extend without a framework migration. |
| excel-addin/src/functions/functions.js | Preserve; no model call is allowed here. |

The local feature/excel-addin branch already contains the deterministic News Hub reader and Ask retrieval facade in src/lib/news.ts and src/lib/askTools.ts. This is completed groundwork, not work to redo. It needs the hardening and tests in section 10 before it becomes a dependency of a provider-backed endpoint.

Nebius and MiniMax server-side credentials are now confirmed and populated in the local .env (alongside the existing ANTHROPIC_API_KEY). This removes the open question of provider access; it does not change the rollout order below. The Deep Dive/Comparison agentic layer (Planning+Context Selection, Verification) is part of the MVP and is built in Phase 2b, not deferred — but it is still built as a second step after each workflow's deterministic core (2a/3a), and every role degrades cleanly if a provider is unavailable (section 7). Only Ask CaribEcon's own agentic retriever (Phase 6) remains genuinely optional and gated behind Phases 0-5 stability. A Tavily credential (TAVILY_API_KEY) is also now confirmed and populated in .env; see sections 3, 5, 6, 8, and 9 for its scope as an Ask CaribEcon-only web-evidence fallback, not a general provider.

## 3. Shared provider architecture

Provider transport belongs behind small server-only adapters. Product workflows own their intents, prompts, evidence policy, and output contracts.

    Excel task pane
        |
    Workflow endpoint/orchestrator
        |-- Single Country workflow
        |-- Country Comparison workflow
        '-- Ask CaribEcon workflow
                |
          AI role services
          - interpret request                          all three workflows
          - plan + select context                       Deep Dive, Comparison
          - synthesize evidence                          all three workflows
          - verify evidence and claims                  Deep Dive, Comparison
          - optional bounded tool loop                   Ask only, Phase 6
                |
          provider adapters
          - Nebius
          - MiniMax
                |
          controlled CaribEcon tools
          - Data Hub
          - News Hub
          - web evidence (Tavily, Ask CaribEcon fallback only)
          - compute registry
          - chart/workbook renderer

Tavily is a retrieval tool, not a text-generating provider: it belongs in the controlled-tools branch, not beside Nebius/MiniMax. It never interprets, reasons, or writes prose — it returns search results with real URLs, exactly like Data Hub and News Hub return records, so the "citations only from real retrieval" rule in section 5 holds unchanged.

The provider layer exposes generic capabilities only:

    generateStructured(request)
    generateText(request)
    runToolLoop(request)       optional, bounded, server-only

It must not contain product methods such as createExcelChart or compareCountries. That keeps a provider swap from requiring a rewrite of CaribEcon concepts.

Suggested server-only structure:

    src/lib/ai/
      config.ts
      types.ts
      providers/nebius.ts
      providers/minimax.ts
      roles.ts
      grounding.ts

The Planning+Context Selection role and the Verification role (section 6, section 7) are purpose-built orchestration functions inside roles.ts, each calling the same two generic provider adapters above — not a generic, reusable agent framework, which section 1's guardrails still prohibit reaching for. A role function owns its own prompt, its own input/output contract, and its own degrade-on-failure behavior; nothing about adding a role requires a shared orchestration abstraction, a state machine library, or a third provider adapter.

Do not place provider calls in task-pane code, custom functions, api/research.ts, or unrelated feature files.

## 4. Configuration and secrets

Provider keys are server-only. Never expose them in an Excel bundle, HTML, API response, log, screenshot, Git, source control, or committed configuration. The local .env remains ignored. Production uses encrypted deployment secrets.

Configuration must allow provider/model changes without code edits:

    NEBIUS_API_KEY=
    MINIMAX_API_KEY=

    CARIBECON_INTERPRETER_PROVIDER=nebius
    CARIBECON_PLANNING_PROVIDER=nebius
    CARIBECON_SYNTHESIS_PROVIDER=nebius
    CARIBECON_VERIFICATION_PROVIDER=minimax
    CARIBECON_ASK_RETRIEVER_PROVIDER=nebius

    NEBIUS_INTERPRETER_MODEL=
    NEBIUS_PLANNING_MODEL=
    NEBIUS_SYNTHESIS_MODEL=
    NEBIUS_ASK_RETRIEVER_MODEL=
    MINIMAX_VERIFICATION_MODEL=

    ASK_RETRIEVER_MODE=deterministic
    ASK_CARIBECON_MODE=ask

    TAVILY_API_KEY=
    ASK_WEB_FALLBACK=off

Rules:

- Planning+Context Selection, Verification, and Ask CaribEcon's optional Phase 6 tool loop are three distinct role functions, each with its **own** provider slot — CARIBECON_PLANNING_PROVIDER, CARIBECON_VERIFICATION_PROVIDER, and CARIBECON_ASK_RETRIEVER_PROVIDER. They were previously collapsed into a single CARIBECON_REASONING_PROVIDER slot; that slot and MINIMAX_REASONING_MODEL are retired, because one slot made it impossible to move Planning to a different provider without moving Verification with it.
- **Verification must not resolve to the same provider as Synthesis.** Verification's job is to check the Synthesizer's output, and a provider checking its own family's work shares its failure modes — it is blind to exactly the errors it would make itself. config.ts emits a loud startup warning when CARIBECON_VERIFICATION_PROVIDER equals CARIBECON_SYNTHESIS_PROVIDER. Deliberately a warning rather than a hard failure, and deliberately **not** an automatic reassignment: section 7's failure table already specifies the correct degradation (skip the verification call, fall back to the code-level check). An honest skip is worth more than same-family verification wearing the label of an independent check.
- ASK_WEB_FALLBACK defaults to off in every environment and is only ever changed after Phase 5b (section 9) is verified. Tavily has no interpreter/reasoning/synthesis role and so no CARIBECON_*_PROVIDER entry — it is a retrieval tool (section 3, section 8), configured on or off, not selected among providers.

- Do not invent or hard-code a model ID for a new provider route. It must be explicitly configured and live-validated at implementation time.
- A new AI route fails closed with a clean configuration error if its provider/model is absent.
- CARIBECON_RESEARCH_TOKEN is the existing client-visible demo cost gate, not a provider secret or production-grade user authentication.
- Provider calls require explicit timeouts, bounded retries, and request-level latency limits.
- Safe telemetry may record role, configured provider/model alias, latency, token use, and fallback outcome. Do not log provider secrets or full prompt/evidence content by default.

## 5. Shared contracts

### Validated intent

Define a top-level discriminated ExcelIntent with separate validated forms:

    ExcelIntent
      - SingleCountryIntent
      - CountryComparisonIntent
      - AskIntent

Every intent contains canonical country codes and real indicator slugs. Structured workflow intents additionally contain an explicit period, requested outputs, and scope.

Comparison scope must distinguish selected countries from an explicitly requested regional/ranking view. Missing countries must never silently become an all-region comparison. AskIntent remains limited to indicator, comparison, and news. An unknown model question type is invalid output, not a reason to default silently to indicator.

### Evidence, calculation, chart, and workbook contracts

Every retrieved series and news item has a stable evidence ID. Every data point retains year, value, type, vintage, source lineage, unit, confidence, and caveats. The package also carries retrieval misses, comparability caveats, tools used, and News Hub archive coverage.

News evidence is stored metadata only: title, source, date, country, URL, category, and tags. The product never implies that it read an article body. Context can be described as coincident or potentially relevant, never causal without attributable evidence.

When ASK_WEB_FALLBACK=tavily and a news/context question's News Hub search reports a miss, retrieval may add web evidence from one bounded Tavily search: title, source domain, URL, snippet, published date if Tavily supplies one, and a retrieval timestamp. Each item is labeled as an external web result, not a News Hub record, in the evidence package and in whatever the client renders, so a reader never mistakes it for a stored, curated CaribEcon source. A model may cite a web evidence item's URL but never treats it as News Hub provenance, and web evidence is never used to answer an indicator or comparison question.

A model may propose an allowed operation through a validated intent. Code performs it from a fixed calculation registry. A new calculation requires deterministic implementation and tests.

A validated ChartSpec defines chart type, indicator, countries, year range, and title. A validated WorkbookPlan defines sections, tables, charts, sources, caveats, and collision-safe placement. Models never emit raw Office.js, workbook coordinates, formulas, source URLs, or citation text.

The renderer uses native Excel objects, never overwrites an existing sheet, and writes provenance with the output.

### Planning and verification contracts

A validated ResearchPlan lists subtasks for Single Country Deep Dive and Country Comparison: each subtask names a real hub indicator slug (or a News Hub query) and a real calculation-registry function name — never free-text math and never an invented slug. This is what the merged Planning+Context Selection role (section 6, section 7) emits; a simple single-indicator explicit-picker request skips planning and goes straight to deterministic retrieval with no ResearchPlan at all.

Evidence Verification and Claims Verification are not separate contracts here — the tightened pipeline merges them into one post-synthesis Verification role sharing a single VerificationVerdict: PASS proceeds to delivery; NARROW tightens the claim's stated scope (for example, "among the 3 peers with 2025 data"); RETRY re-fetches evidence or asks Planning to re-plan, capped at one attempt total, not per subtask; ESCALATE withholds the narrative and routes to the Human Review Gate (section 6) while tables, charts, and sources still write. Verification never edits a number itself — only the Compute Service can supply a number, so NARROW or RETRY changes scope or evidence, never a value.

### Grounded synthesis

The synthesizer sees only the original request, validated intent, and bounded evidence package. Prompts are not the enforcement mechanism. The response is checked against evidence IDs and allowed data before display.

Unsupported figures, URLs, citations, or causal claims cause a safe fallback: deterministic key data, sources, and caveats appear with an explanation-unavailable state.

## 6. Product workflows

### Browse and custom functions

Browse remains a deterministic country/indicator/year-range selector. The seven CE functions remain read-only values/formulas backed by the shared snapshot. Neither invokes an LLM.

### Single Country Deep Dive and Country Comparison

Both workflows run the same seven-step tightened pipeline; Comparison additionally aligns periods across 2+ countries, blocks incompatible local-currency comparison, and calculates only registered cross-country metrics. The initial Comparison showcase is Trinidad and Tobago versus Guyana. If countries, indicators, or an overlapping period are missing, either workflow reports the gap — it never invents a comparison or retrieves the whole region by default.

    User request (explicit picker or natural language)
      |
      v
    [1] Interpreter (Nebius)                 -> validated SingleCountryIntent / ComparisonIntent
      |                                          skipped entirely for explicit-picker input
      v
    [2] Planning + Context Selection         -> one Nebius call: ResearchPlan (real slugs and
        (Nebius, merged)                         registry function names only) plus a relevance
      |                                          judgment over candidate News Hub items. Skipped
      |                                          for a simple single-indicator picker request.
      v
    [3] Deterministic retrieval + compute    -> indicators.ts / news.ts / the calculation
        (code only)                              registry. A model never produces a number that
      |                                          appears in the output.
      v
    [4] Synthesis (Nebius)                   -> concise explanation from verified evidence only,
      |                                          attributed language, no unattributed causation.
      v
    [5] Verification (MiniMax, merged)       -> one post-synthesis call checking both the
      |                                          computed values' evidence support and the
      |                                          written claims. PASS / NARROW / RETRY (one
      |                                          attempt) / ESCALATE.
      v
    [6] Delivery (code)                      -> ChartSpec/WorkbookPlan -> native Excel tables,
      |                                          charts, sources, caveats, and a second Evidence
      |                                          sheet with full lineage.
      v
    [7] Human Review Gate (task pane)        -> only on ESCALATE.

Every step's provider is optional in the sense that its absence or failure skips that step rather than failing the request — section 7 lists the exact degrade behavior per role. Steps 1, 3, and 6 alone are the deterministic core: a complete, demoable workflow with zero agent involvement, and the automatic fallback for every agent role above it.

The Human Review Gate fires only on an ESCALATE verdict from step 5. It withholds the narrative and shows an escalation-reason category instead — source conflict, low-confidence evidence in a material claim, or unattributed causal language — never the Verification role's raw output or reasoning trace, per section 8's rule against exposing reasoning traces or internal tool calls. Tables, charts, sources, and caveats still write regardless of an escalation; only the prose explanation is withheld pending the analyst's own judgment. It is not a blocking modal — the analyst is the final human here, same as the retired workflow PDF's own framing.

### Chart and output generation

AI may identify that a request calls for a line chart of GDP growth for Guyana and Trinidad and Tobago. The validated ChartSpec drives deterministic Office.js chart creation. The renderer chooses range placement, headings, native formatting, and source attachment.

### Ask CaribEcon

Ask is a separate conversational surface reusing the same provider role services, Data/News tools, evidence contract, grounding checks, and source renderer.

    question
      -> configured interpreter
      -> validated AskIntent
      -> deterministic retrieval by default
      -> EvidencePackage
      -> configured synthesizer
      -> grounded answer plus deterministic key data and sources

The first Ask implementation is plain JSON through api/ask.ts. It does not replace api/research.ts and does not stream until normal request/response behavior is reliable.

For a news/context question, deterministic retrieval queries the News Hub first. If ASK_WEB_FALLBACK=tavily and that search reports a miss, retrieval makes exactly one bounded Tavily search inside the same date window before the EvidencePackage is built. It never runs for indicator or comparison questions, never runs a second time in one request, and a disabled or failed Tavily call simply leaves the existing News Hub gap caveat in place — see section 7.

## 7. Provider roles and failure behavior

| Role | Default | Used by | Responsibility |
| --- | --- | --- | --- |
| Interpreter | Nebius | All three workflows | Strict structured intent extraction only. |
| Planning + Context Selection | Nebius | Deep Dive, Comparison | Decompose the intent into a ResearchPlan naming only real indicator slugs and calculation-registry functions; judge which retrieved News Hub items are relevant. Skipped for a simple single-indicator explicit-picker request. |
| Synthesizer | Nebius | All three workflows | Concise, attributed explanation from supplied evidence only. |
| Verification | MiniMax | Deep Dive, Comparison | One post-synthesis check of both computed-value evidence support and the written claims; emits a VerificationVerdict (section 5). Deliberately **not** Nebius: it checks the Synthesizer's output, so it must not share the Synthesizer's provider family (section 4). |

Planning+Context and Verification are part of the Deep Dive/Comparison MVP (Phase 2b/3b, section 9), not optional extras — this is different from the genuinely optional Phase 6 retriever role below. Ask CaribEcon does not use either: it stays the lighter Interpreter → deterministic retrieval → Synthesizer shape, reusing the same two provider adapters but none of the Planning/Verification orchestration built for the structured workflows.

Separately, CARIBECON_ASK_RETRIEVER_PROVIDER (Nebius by default) powers Ask CaribEcon's own optional agentic retriever (Phase 6, ASK_RETRIEVER_MODE=agentic) — a bounded tool loop over the original question, validated intent, and an allowlist of controlled tools, unrelated to the Planning/Verification roles above. It is not required for the MVP and remains gated behind Phases 0-5 stability. It cannot access the web, write user-facing answers, create citations, or retrieve outside CaribEcon — that stays true even after the Tavily fallback ships, since Tavily is called by deterministic code in the news branch of buildEvidencePackage, never by a retriever tool call.

Note the cost profile before enabling it: a tool loop resends the accumulating message history on every turn, so spend grows far faster than the two-call deterministic path. That is a second reason, alongside reliability, why it stays off by default.

Tavily is a bounded retrieval tool used only inside Ask CaribEcon's news/context path (section 6). It has no interpreter, planning, verification, or synthesis role and is not part of the provider-role table above.

`api/research.ts` is not migrated to Nebius/MiniMax. It stays frozen and untouched exactly as section 2 describes through Phase 5, and is deleted — along with the `ASK_CARIBECON_MODE=legacy` switch — once `api/ask.ts` is stable (section 9, Phase 5 exit). Migrating a path about to become redundant is not worth the effort; retiring it removes the only remaining Anthropic dependency in this plan's new work. Anthropic is not fully retired at that point: `src/lib/newsClassifierLLM.mjs` (the daily news classifier) still runs on Claude Haiku and is migrated separately, outside this plan's scope.

| Failure | Required behavior |
| --- | --- |
| Planning+Context unavailable (Deep Dive/Comparison) | Skip planning; the validated intent alone drives deterministic retrieval, same as an explicit-picker request. No News Hub relevance filtering — deterministic keyword search only. |
| Verification unavailable (Deep Dive/Comparison) | Skip the merged verification call; fall back to the existing code-level check (section 5's "unsupported figures/URLs/citations cause a safe fallback"). |
| Agentic retrieval unavailable (Ask, Phase 6 only) | Use deterministic retrieval mode. |
| Interpreter unavailable | Explicit structured controls remain usable; return a clean natural-language failure. |
| Synthesis unavailable after evidence retrieval | Produce tables/charts/key data/sources without narrative. |
| New Ask route unavailable | Use ASK_CARIBECON_MODE=legacy on the next build/deployment, until api/research.ts is deleted per above. |
| Provider output invalid or unsupported | Reject it and return a bounded gap/failure state. |
| Tavily unavailable, disabled, or errored | Ask CaribEcon proceeds with Data Hub and News Hub evidence only; the News Hub coverage-gap caveat still appears; the request never fails because of it. |

Do not automatically invoke api/research.ts inside a failed api/ask.ts request. The endpoints have different contracts and automatic fallback can spend extra tokens or make the output ambiguous.

## 8. Deterministic tool and API boundaries

The controlled tool layer may expose only operations backed by records and code:

    listCountries
    listIndicators
    resolveCountry
    resolveIndicator
    getSeries
    getSelectedCountrySeries
    searchNews
    searchWeb            optional, Tavily fallback, news questions only
    buildEvidencePackage
    runCalculation
    buildChartSpecification
    buildWorkbookPlan
    insertTableIntoExcel
    createExcelChart

Reuse indicators.ts, news.ts, and askTools.ts. Do not create a second Data Hub reader, copy series logic, or give a model a raw JSON store.

searchWeb wraps a single bounded Tavily basic-search call behind the same date-window enforcement as searchNews (dateFrom/dateTo derived from the validated AskIntent, matching NewsEvidence's YYYY-MM-DD convention) and returns typed WebEvidence records with a stable id, title, source domain, url, snippet, published date if available, and retrieval timestamp — never raw HTML, never a full article body, never more than a handful of results. It lives in a new src/lib/webEvidence.ts alongside news.ts, reuses askTools.ts's existing canonicalisation and date-window logic rather than duplicating it, and is only ever called from the news-question branch of buildEvidencePackage, and only after a confirmed News Hub miss.

Historical context queries must have enforced date windows. A question about 2024 returns a coverage gap if the News Hub lacks 2024 records; it never substitutes unrelated current stories.

api/ask.ts is a new authenticated, rate-limited Vercel function:

    validate request/auth/rate limit
      -> interpret and validate intent
      -> deterministic retrieval by default
      -> optional bounded agentic retriever later
      -> build evidence package
      -> synthesize and ground-check
      -> deterministic sources, key data, caveats, follow-ups
      -> JSON response

Follow-up suggestions are deterministic from validated intent. The client renders links only from deterministic source records after URL-safety checks.

Keep the task pane vanilla HTML/CSS/JavaScript. Add an ASK_CARIBECON_MODE=ask|legacy build-time switch, honest loading state, structured answer/key-data/source rendering, and enhanced insertion. Fixed demo-safe prompts are permitted. Do not expose reasoning traces, internal tool calls, provider messages, or secrets.

## 9. Build order

### Phase 0 - deterministic evidence core

Completed locally: src/lib/news.ts and src/lib/askTools.ts.

Before the next phase, add/verify tests for metadata-only news search, publication filtering, date windows, canonicalisation, invalid intent handling, selected-country scope, multiple comparison indicators, point-level vintages, missing coverage, and unit comparability.

### Phase 1 - stabilize the existing add-in

Protect Browse, shared snapshot loading, seven custom functions, existing insertion, and the legacy api/research.ts path with regression checks. No provider work may break this baseline.

### Phase 2 - Single Country Deep Dive

**2a - deterministic core.** Build deterministic input, retrieval, compute, tables, charts, provenance, and workbook rendering (section 6, steps 1/3/6 only). This alone is a complete, demoable workflow and the acceptance floor if 2b slips.

**2b - agentic layer.** Add the shared src/lib/ai adapter boundary (Nebius, MiniMax — built once here, reused by 3b and Phase 5) and wire the Planning+Context Selection and Verification roles (section 6, steps 2/4/5; section 7) plus the Human Review Gate UI state in the task pane. Disabling either provider must leave 2a fully operational per section 7's failure table.

### Phase 3 - Country Comparison

**3a - deterministic core.** Build selected-country comparison, period alignment, comparability safeguards, approved calculations, deterministic chart/workbook output, and sources (section 6, steps 1/3/6). Trinidad and Tobago/Guyana is the first acceptance case.

**3b - agentic layer.** Wire the same Planning+Context Selection and Verification roles built in 2b to the comparison intent and evidence — no new adapters, no new provider code, only the comparison-specific ResearchPlan/evidence shapes.

### Phase 4 - polish and regression

Polish both primary workflows' tables, charts, sources, and Human Review Gate UX. No new AI roles are added here — 2b already built the shared adapter boundary and both agentic layers; this phase is hardening and regression coverage only.

### Phase 5 - baseline Ask CaribEcon

Build api/ask.ts and task-pane integration reusing the Interpreter and Synthesizer role services built in 2b, plus deterministic retrieval — no Planning or Verification roles (section 7). The default path uses at most two model calls: Interpreter then Synthesizer. Once this phase is stable, delete api/research.ts and the ASK_CARIBECON_MODE=legacy switch (section 7) — that is this phase's exit condition, not just "ships."

### Phase 5b - optional Tavily web-evidence fallback

Only after Phase 5 ships and the deterministic news path is stable. Add src/lib/webEvidence.ts, extend the news branch of buildEvidencePackage to call it on a confirmed News Hub miss, and wire ASK_WEB_FALLBACK. It defaults to off in every environment, including production, until this phase is verified per section 10. Disable it immediately if it adds latency or unreliable results to the news path; it must never gate the Ask CaribEcon MVP, and it is independent of Phase 6 — either can ship, stay off, or roll back without touching the other.

### Phase 6 - optional agentic retriever

Only after Phases 0-5 are stable, live-validate the CARIBECON_ASK_RETRIEVER_PROVIDER tool protocol and add a bounded loop behind ASK_RETRIEVER_MODE=agentic. Keep its evidence/response contract identical to deterministic mode — both modes must return the same EvidencePackage shape, which is what makes this an added mode rather than an endpoint rewrite. Disable it if it harms reliability, latency, or cost; note that a tool loop resends accumulating history each turn, so its cost profile is materially worse than the two-call deterministic path.

### Phase 7 - optional streaming and polish

Add streaming only if it works in Excel. Complete design QA, error states, demo rehearsal, and deployment verification.

## 10. Verification gates

No phase advances without appropriate checks.

### Deterministic tests

- country and indicator resolution, aliases, and invalid values;
- selected versus regional comparison scope;
- period alignment, missing values, estimates/projections, and local-currency safeguards;
- News publication filter, metadata-only behavior, ranking, and temporal windows;
- calculation registry plus ChartSpec and WorkbookPlan validation;
- evidence IDs, point-level provenance, and source preservation;
- web-evidence fallback fires only on a confirmed News Hub miss for a news-type question, respects the same date window, is capped to one call per request, is skipped entirely for indicator/comparison questions, and is skipped whenever ASK_WEB_FALLBACK is not "tavily";
- ResearchPlan validation: a subtask can only name a real hub indicator slug (or News Hub query) and a real calculation-registry function; an invented slug or free-text math is rejected, not silently dropped or guessed;
- the merged Verification role's retry cap (one attempt total) and its ESCALATE path route to the Human Review Gate without erroring the request;
- an ESCALATE verdict withholds the narrative only — tables, charts, sources, and caveats still write;
- Planning+Context and Verification unavailability each degrade to the documented fallback (section 7) without failing the request, for both Deep Dive and Comparison independently.

### Provider and grounding tests

- mocked Nebius/MiniMax structured-output and error contracts;
- missing provider/model configuration and timeouts;
- invalid model JSON and unsupported tool requests;
- rejection of unsupported figures, URLs, citations, and causal claims;
- Ask CaribEcon deterministic mode with MiniMax credentials absent entirely — Ask depends on no MiniMax role, so this must be a no-op;
- Deep Dive/Comparison with MiniMax credentials absent — Verification is skipped and the code-level check runs, per section 7's failure table;
- config.ts warns when CARIBECON_VERIFICATION_PROVIDER equals CARIBECON_SYNTHESIS_PROVIDER, and still starts (warning, not hard failure, per section 4);
- provider failures that leave structured workflows usable;
- Tavily disabled or TAVILY_API_KEY absent leaves Ask CaribEcon's news path unchanged from today's behavior; a Tavily error or timeout degrades to the News Hub-only gap caveat without failing the request; a web evidence item is always labeled as external, never rendered as a News Hub source.

### Integration and Excel checks

- authenticated/rate-limited api/ask.ts calls with mocked provider traffic;
- legacy mode calling untouched api/research.ts, through Phase 5's exit only — once api/research.ts and ASK_CARIBECON_MODE=legacy are deleted (section 7, section 9), confirm no remaining reference to either in code, env examples, or the task pane;
- tables, charts, sources, key data, and caveats written to an open workbook;
- actual Excel/Office WebView2 task-pane smoke test;
- npm test, npm run check, npm run build, npm run build:addin, add-in lint/manifest validation, and git diff --check as applicable;
- inspect the built add-in bundle to confirm no provider key or model secret was injected.

## 11. Likely file map

| Change | Files |
| --- | --- |
| Reuse/harden | src/lib/indicators.ts, src/lib/news.ts, src/lib/askTools.ts |
| Add (Phase 2b, shared) | src/lib/ai (config.ts, types.ts, providers/nebius.ts, providers/minimax.ts, roles.ts, grounding.ts) — built once here, reused by 3b and Phase 5. No separate adapter file is needed per role; roles.ts routes all four roles in section 7's table through the same two provider adapters. |
| Add (Phase 2a/3a) | deterministic compute/chart/workbook-plan modules, focused tests |
| Add (Phase 5) | api/ask.ts |
| Add (Phase 5b, optional) | src/lib/webEvidence.ts, its tests |
| Extend | excel-addin task-pane HTML, JavaScript, CSS, and webpack configuration, including the Human Review Gate UI state (Phase 2b) |
| Preserve through Phase 5, then delete | api/research.ts and the ASK_CARIBECON_MODE=legacy switch (section 7, section 9) |
| Preserve indefinitely | api/indicator.ts, api/snapshot.ts, custom functions, shared hub |
| Document | CLAUDE.md and this plan |

Do not modify a file merely to make the architecture symmetrical. Reuse a proven module where possible and add one only when it has a clear boundary.

## 12. Out of scope and documentation precedence

The architecture leaves room for saved analyses, open-ended multi-hop web research, crawling, document outputs, deeper reconciliation, and broader Office integration. None of those is part of this buildathon MVP. The Phase 5b Tavily fallback is a narrow exception already scoped into this plan (sections 3, 5, 6, 8, 9): one bounded search call, only for Ask CaribEcon news/context questions, only after a News Hub miss, off by default. It is not the "controlled web research" this section still defers — that phrase now means anything broader than the single bounded fallback described above.

The initial success criterion is not a count of agents or providers:

> A real request produces an editable Excel output from CaribEcon evidence, with correct calculations, traceable sources, honest gaps, and no invented data.

This document is the active Excel engineering plan. It now incorporates a tightened version of the retired `CaribEcon_Build_Worflow.pdf`'s multi-agent pipeline for Deep Dive/Comparison (section 1, section 6, section 7) — that architecture was correct in shape, wrong only in being CariBench-coupled and sized for a 6-role/two-verifier design this plan deliberately trims to 4 roles and one merged verifier. The PDF itself, and its CariBench/team-lane/day-gate specifics, remain retired and non-authoritative; only the tightened pipeline described in this document governs implementation. Historical changelogs and archived plans remain records; they do not override this document.

