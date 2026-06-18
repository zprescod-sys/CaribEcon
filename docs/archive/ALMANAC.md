# CLAUDE.md — Caribbean Macro Almanac

Read this at the start of every session to re-ground context. Update "Current State" and "Next Steps" at the end of every session.

## What This Is

A multi-page Caribbean macroeconomic research tool. Multiple economies, seven-plus indicators, budgets, news, publications, deals, and a client-facing chart builder. Not a landing page — separate pages sharing one shell and one data hub.

Purpose and bar: a portfolio-grade piece for a GitHub repo and a LinkedIn project — evidence of connecting a real economic problem to a structured workflow. It should look professional and near-perfect. Optimize for credibility and rigor over visual flash. Design direction lives in DESIGN_SYSTEM.md; read it before any UI work.

Initial data scope: focus on Guyana and Trinidad & Tobago for accuracy, with the structure built to add the other economies later.

## Build Setup

Fable or other models does the majority of the coding, in VS Code. Pages. These MD files brief Fable — keep them tight and unambiguous.

## Data Hub (do this first)

All pages read from one shared data hub, never from per-page hardcoded values. Build the hub before the pages.

1. Collect and clean data in Python tools (scrub, normalize, cross-check).
2. Write it to a single global store the whole site reads: structured JSON in /data (e.g. data/dashboard.json, data/budgets.json, data/news.json, data/publications.json, data/deals.json). One source of truth.
3. Every page (home, data, news, publications, deals, analysis) pulls from this hub. No section keeps its own copy.

Phase 1 (now): static dataset, hand-collected, to get the full outline working. Use the most recent comprehensive year available across sources (target 2024; use 2025/2026 where complete). Scope to Guyana and Trinidad & Tobago.
Phase 2 (later): a scheduled scraper/fetcher refreshes the hub incrementally (e.g. daily to weekly) so data goes live without touching page code.

## Data Integrity (hard requirement)

This is the project's main credibility signal.
- Every number traceable to its source and vintage, surfaced in the UI.
- Cross-reference across at least two independent sources where possible; flag material disagreements rather than silently picking one.
- Never mix estimates/projections with actuals without labeling; distinguish them visually.
- Prefer primary sources (IMF, World Bank, national statistics offices, central banks) over aggregators.
- For any derived figure, document the formula and inputs.
- When a value can't be verified, show it as unavailable rather than guessing.
- News and publications: show headline/title + source + date + link out. Never republish article bodies.

## Pages (one sub-agent each)

Each page is built by its own sub-agent in its own domain, then consolidated. See orchestration below.
- Home — daily briefing + regional visual + links into sections.
- Data — chart explorer + CSV export + budget pie (centre total, allocation breakdown, key projects on segment click) + parallel views for FDI and spending-vs-tax-revenue.
- News — all Caribbean news, filterable by country.
- Publications — INDEX of reports (IMF Article IV consultations, World Bank, regional bodies). Store title, summary (your words), type, date, source link. Host nothing, link out; never embed PDFs or reproduce report charts/tables.
- Deals & Investment — headline M&A, transactions, FDI activity; headlines only.
- Analysis — DEFERRED this round (kept in plan). Client-facing builder: user sets parameters and generates a chart/table to export. Build the hub and chart components so they could feed it later; no sub-agent works on it yet.

## Agent Orchestration Model

All non-trivial work runs through agents and sub-agents, in isolation, then consolidates. This keeps context lean and lets large changes happen safely.

1. The main agent plans the task and divides it by page/domain with NON-OVERLAPPING file ownership. Two sub-agents must never own the same file in one cycle — clean boundaries are the main agent's first responsibility. Shared shell (nav, tokens, data hub) is built first and frozen before page agents start.
2. For each page, the main agent initializes a sub-agent with its own scoped instructions file: its objective, the exact files it owns, the data-hub keys it reads, and only the skills, commands, and functions it needs.
3. Sub-agents work in isolation, each in its own workspace, touching only files they own.
4. When all sub-agents finish, they return to the main agent, which consolidates.
5. On consolidation, the main agent runs a self-improvement loop: if a file is broken or two agents' changes conflict, identify what broke, fix it, verify the fix, and record the cause so it does not recur.
6. You are in charge of building the sub agents files, storing them and equiping with the relevant tools to best do their job 

Rules:
- Scope each sub-agent narrowly — minimum context to do its job. This is the main token-saving mechanism.
- A sub-agent that errors reads the full trace, fixes and retests; if a fix uses paid API calls, check before re-running.
- Prefer existing tools/commands before creating new ones.
- Do not overwrite shared files (this file, DESIGN_SYSTEM.md, the data hub, the shell) without asking.

## Architecture (WAT — Workflows, Agents, Tools)

Separate probabilistic reasoning from deterministic work. The front end is a pure presentation layer that reads the data hub; it never calls external APIs directly. Keep API keys server-side (Cloudflare Worker / Pages Function) for any live calls. Everything regenerable lives in /data or /.tmp.

## Coding Philosophy

- Ship working code first, refine later. Preserve existing working functionality unless told otherwise.
- Readable by a non-expert — clear names, a short comment on every non-trivial function. Hard requirement.
- Clear over clever. No enterprise patterns or unnecessary abstractions.
- Minimize dependencies; add a library only if it meaningfully reduces complexity.
- Smallest effective change; avoid scope creep.
- When uncertain about approach or architecture, ask before building.

## Git & Workflow Discipline

- Keep main clean; build the shell/data hub on main, each page on its own branch, consolidate via merge.
- Commits as explicit restore points before any non-trivial change; commit every working increment.
- Use Plan Mode for complex build/design tasks.
- Update this file at the end of every session.

## Current State

- Prototype HTML (single page) exists as the visual/interaction reference: daily-briefing hero, chart explorer, year-in-focus panel, news feed, hard-edged "sovereign almanac" styling. Treat it as the look-and-feel substrate, to be split into the multi-page structure above.

## Next Steps

- Build the shared shell (top bar + nav + design tokens) and the data hub (static Phase 1, Guyana + Trinidad).
- Spin one sub-agent per page against the frozen shell and hub.
- Wire CSV export and the budget pie on the Data page.
