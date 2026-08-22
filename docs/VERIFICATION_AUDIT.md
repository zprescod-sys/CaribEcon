# Verification audit - current deterministic publish gate

**Status:** completed code audit, 2026-08-22. This is the Phase 4 starting point. It is not an
authorization to add a second model reviewer.

## Conclusion

Yes, the existing deterministic system already supplies the core verification behavior needed to
publish or suppress Ask claims. `research()` always calls `verify()` after synthesis. `verify()`
runs `runGroundingGate()`, derives `publishedClaims` in code, and the task pane renders and inserts
only those claims. The model neither issues the verdict nor gets to edit a failing claim.

Phase 4 should therefore be verification hardening, observability, and targeted regression tests.
A MiniMax claims audit remains deferred/experimental. It should be reconsidered only if a measured
benchmark finds a material failure class that survives the gate.

## Live flow

```text
question -> interpret -> validated plan -> deterministic retrieval/execution
         -> compile evidence -> synthesize structured claims -> deterministic grounding
         -> code-derived verdict -> render/insert only published claims
```

- `api/ask.ts` calls `research()` and returns the canonical result.
- `src/lib/ai/research.ts` calls `verify(answer, evidence)` after synthesis.
- `src/lib/ai/verify.ts` converts violations into `publishedClaims`, `publishedHeadline`, a
  `PASS`/`NARROW` outcome, and stable reason categories. A violating claim is excluded; it is
  never rewritten by a model.
- `excel-addin/src/taskpane/taskpane.js` filters on `verdict.publishedClaims` before display,
  citation rendering, history refs, or Excel insertion. It replaces an unpublished headline with
  a safe notice.

The optional `ClaimsAudit` type exists, but every live call uses `{ ran: false }`; there is no
model audit in the current request path.

## Deterministic gates

| Gate | What it checks and protects | Publish/drop rule |
| --- | --- | --- |
| `ref_existence` | Every declared claim/figure reference is in this request's `EvidencePackage`. Stops invented or stale citations. | Missing reference drops the claim. |
| `url_allowlist` | URLs written in a claim exactly match a retrieved source after safe normalization. Stops invented domains and fabricated paths. | Unknown URL drops the claim. |
| `slug_tokens` | Non-framing prose cannot name a hub country or indicator absent from retrieved evidence. | Unsupported named subject drops the claim. |
| `figure_reconciliation` | Raw data figures exist at the stated period; calculated figures are recomputed deterministically. | Missing, wrong, or unreproducible number drops the claim. |
| `wrong_calculation` | A percent-unit series uses percentage-point change rather than percent change, and vice versa. | Wrong calculation semantics drops the claim. |
| `unstated_number` | Numeric prose is a declared figure, a retrieved year, or a small narrative count. | Undeclared/fabricated numeric assertion drops the claim. |
| `news_body_claim` | `N:`-only news is headline metadata, not article text. It cannot carry figures or long quotations. | Unsupported article-body assertion drops the claim. |
| `quote_check` | A quoted span must occur verbatim in cited retrieved `W:` extract text. | Invented/mismatched quote drops the claim. |
| `cross_currency_comparison` | Comparative wording cannot compare figures with incompatible non-percent units. | Analytically invalid comparison drops the claim. |
| `coverage_honesty` | A stated data year lies within the retrieved series range. | Out-of-range coverage assertion drops the claim. |
| `web_figure_reconciliation` | A web-backed number has a retrieved extract and appears in its text. Search snippets alone are insufficient. | Unsupported web figure drops the claim. |

Malformed synthesis JSON does not enter this stage: `parseSynthesisResponse()` rejects it and
`api/ask.ts` returns a safe retryable model error. Invalid claim objects are removed during
structural coercion before verification.

## Existing test evidence

`src/lib/ai/grounding.test.mjs` exercises real captured answers and targeted cases for all eleven
checks, including fabricated/undeclared numbers, missing references, fabricated URLs, news-body
misuse, fabricated quotes, incompatible currencies, out-of-range years, and fabricated web
figures. `verify.test.mjs` proves a violating claim is absent from `publishedClaims`, including
adversarial percentage regressions and headline handling. `research.test.mjs` proves `verify()` is
in the live composition.

This is strong coverage for deterministic evidence integrity. It is not proof that every
qualitative assertion is semantically true.

## Real gaps and minimal next actions

1. **Unreferenced framing claims can pass.** `coerceClaim()` permits a `framing` claim with no
   refs, and the gate deliberately exempts framing claims from slug and numeric checks. A model
   could label an unsupported factual assertion as framing. Add a regression test first, then make
   model-authored framing text either cite evidence or restrict it to a deterministic gap/status
   template.
2. **An empty `headlineRefs` array is considered publishable.** An unsupported qualitative
   headline can therefore pass even when it has no evidence linkage. Add an adversarial test and
   require a headline reference whenever the headline makes a substantive claim; otherwise render
   a deterministic neutral heading.
3. **Semantic entailment is intentionally out of scope.** A qualitative assertion with a real
   reference but no number, named unsupported country/indicator, URL, or quote can still exceed
   what that source says. The same is true of causal direction, representativeness/cherry-picking,
   forecast reasonableness, and whether the answer addresses the question. Do not add a reviewer
   yet: collect failures from a benchmark first and choose the smallest mechanism for the proven
   class.

## Minimal observability and test plan

Log one safe aggregate event per completed Ask request: request ID, question category, model and
prompt version, total and stage latency, generated/published/dropped claim counts, drop counts by
`GroundingCheck`, outcome, and whether the headline was withheld. Never log prompts, model output,
article text, credentials, or reasoning.

Add tests for the two immediately actionable gaps above. Maintain the existing fabricated number,
unsupported figure, citation, malformed output, thin evidence, out-of-hub, range, comparison and
web-evidence tests; add a fixed end-to-end benchmark set that records only safe aggregate verdict
metrics. A model audit is justified only if that set exposes a recurring semantic failure that the
deterministic rules cannot catch.
