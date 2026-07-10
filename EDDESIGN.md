# DESIGN_SYSTEM.md — CaribEcon

The visual contract for this project. Read before any UI work. Derive every color, type, and spacing decision from here. This is the merged, canonical system: built on the disciplined petrol-and-gold direction, with a few warmth refinements folded in (generous hero spacing, clean white data surfaces).

## Scope & Authority

This document is the sole authority on aesthetic direction for this project — color, type, motion, layout boldness, and visual register. Where it conflicts with the general frontend-design skill's default guidance (bold maximalism, dominant color, texture/atmosphere effects, scroll-driven choreography), this document wins, no exceptions. See **Explicitly Overridden** below for the specific defaults that do not apply here.

The general skill still applies for everything this document doesn't cover: code quality, semantic markup, performance, and accessibility implementation. This file governs *what it should look like*; the skill still governs *how well the code is written*.

## Thesis

A multi-page Caribbean macroeconomic research tool with the register of a research institute, more than a consumer app. The data is the hero. Distinctive through typography, structure, and disciplined color — not decoration, but still well displayed and designed.

This is a portfolio-grade piece: it should look professional and near-perfect, the kind of project that stands on a GitHub repo and a LinkedIn post as evidence of connecting a real economic problem to a real workflow. Build to that bar.

The vision is restrained, not minimal-by-default — elegance comes from precision, not elaboration. Execute the quiet version meticulously rather than adding boldness to compensate for it. Restraint should still feel *inviting*: breathing room and clean surfaces do the warming, not extra color or ornament.

Avoid the three AI-default looks: warm-cream + serif + terracotta; near-black + one acid accent; generic newspaper broadsheet.

## Explicitly Overridden

The general frontend-design skill defaults to bold/maximalist marketing-site conventions. The following do **not** apply to this project, full stop:

- Dominant color blocks or "sharp accent over timid palette" — the muted, disciplined palette in this document is the deliberate choice, not a placeholder to make bolder.
- Noise textures, gradient meshes, grain overlays, custom cursors, decorative borders, dramatic/layered shadows.
- Asymmetric, diagonal, or overlapping layout; grid-breaking elements for their own sake.
- Oversized hero type (6rem+), horizontal marquees, count-up number animation, scroll-jacking, scroll-pinned sections, or GSAP-driven color-zone transitions. (These come from the skill's scroll-driven-site guidelines, which target a different product entirely and shouldn't inform this build at all.)

What still carries over from the general skill: pick distinctive type (already satisfied — see Typography), avoid generic component patterns, and match implementation complexity to the chosen vision. Here the vision is restraint, so "matching complexity" means precision in spacing and detail, not added effects.

## Color

Use as CSS variables. Cool paper base, deep petrol ink, marine teal brand, gold signal accent. Add muted color so it doesn't read as all-white — use tinted surfaces and section accents, never bright fills. Reserve clean white for data-display surfaces (charts, news lists) so the data reads crisp and unencumbered.

- --paper      #ECEEE8  page background (cool off-white)
- --paper-warm #E6E9E0  alternate section band (subtle tint, for striping pages)
- --surface    #FFFFFF  clean white surface for data display (charts, news lists)
- --card       #F6F7F2  raised surfaces
- --card-tint  #E8EFE9  tinted card for emphasis blocks (faint teal-green)
- --ink        #0F231E  primary text (deep petrol green-black)
- --ink-soft   #4C5A54  secondary text
- --ink-faint  #8A958F  captions, axis labels
- --line       rgba(15,35,30,0.12)  hairlines and borders
- --teal       #0E5E4E  brand / primary
- --teal-deep  #093F34  dark panels
- --gold       #BC8A2E  signal accent only — live point, key emphasis. Never decorative.
- --pos        #2F7D5B  positive deltas
- --neg        #B4543E  negative deltas

Use muted color deliberately: tinted section bands (--paper-warm), tinted emphasis cards (--card-tint), colored 3px left-borders, and the chart series palette below. Keep large fills quiet; saturation lives only in data marks and the gold accent.

Surface rhythm: alternate sections between --paper / --paper-warm to avoid flat white *for content-and-navigation zones*, but place primary data displays (the regional chart, the news list) on clean --surface white. The white surfaces give the data room to breathe and read as the precise, trustworthy core of the page; the tinted bands frame and separate them.

Chart / category series palette (muted, designed — never neon, never rainbow):
teal #0E5E4E · gold #BC8A2E · navy #1E3A5F · clay #A8542E · plum #6A4A6E · slate #5A6B6E · moss #5C6B3A · rust #9A5B2E

## Typography

- Display: Bricolage Grotesque (700/800) — page titles, section headings, stat values, story titles.
- Body / UI: Hanken Grotesk (400/500/600) — paragraphs, controls, labels.
- Data / mono: JetBrains Mono (400/500) — eyebrows, axis ticks, sources, timestamps, nav, the ticker.

Scale: page title clamp(34–52px) lh 1.0 · section 28–30px · card/story title 17–19px · body 16px lh 1.6 · caption/mono 11–13px.
Sentence case everywhere. Two body weights only (400, 500). Tabular numerals for all data.

Eyebrows are the signature label: JetBrains Mono, uppercase, --teal, wide-tracked (.14–.18em). Reuse this treatment wherever a section needs a quiet opener.

This pairing already satisfies the "no generic fonts" rule — no further font exploration needed.

## Geometry — Hard Edges

- Border radius: 0 on cards, panels, buttons, inputs, chart containers, nav items.
- Exception: pure circles only (legend dots, live point, pie segments). Nothing else is rounded.
- Borders: 1px solid --line. Use a 3px left border in --teal or --gold to mark emphasis blocks (e.g. the active-country tag and the key-indicators rail).
- Flat surfaces. No drop shadows except a functional square offset shadow on open dropdowns/menus.

## Spacing & Rhythm

Generosity is the warmth in this system — when a section is the focal point, give it room rather than another element.

- Section side padding: 40px on the framed surface; the shell's outer side padding is 28px.
- Section rhythm ~44–52px of vertical padding, separated by 1px --line dividers.
- **Hero / lead block gets the most air:** ~52px top/40px sides, with a ~48px gap between the lead column and its rail. The lead is the first impression — let it breathe.
- Standard internal gaps 14–24px. Keep them consistent within a zone.
- Two-column tool layouts collapse to one column under 820px.

## Multi-Page Structure

This is NOT a landing page. Separate pages, shared shell (top bar + persistent nav). Every page pulls from the same data hub (see CLAUDE.md). Pages:

1. Home — daily briefing + regional indexed-GDP visual + quick links into each section. (The briefing is built as a content-agnostic shell — see Dynamic-Content Shells.)
2. Data — interactive chart explorer (country multi-select, indicator selector, year-in-focus panel, stat cards, insight callout) + CSV export of any selection + budget view: a pie chart with total budget in the centre, allocation breakdown, and key projects/initiatives shown under the pie or on segment click. Mirror the budget treatment for FDI and for government spending vs tax revenue.
3. News — all Caribbean news by default, filterable by individual country.
4. Publications — a browsable INDEX of reports from major bodies (IMF Article IV consultations, World Bank, regional institutions). Store title, body, type, date, your own short summary, and a link to the source. Host nothing — link out. Never embed the PDFs or reproduce report charts/tables.
5. Deals & Investment — headline M&A, transactions, and FDI activity. Headlines only, no deep specifics.
6. Analysis (client-facing) — DEFERRED, not built this round, but kept in the architecture: users specify exactly the data and parameters they want and generate their own chart, table, or visualization for export. Build the data hub and chart components so they could feed this later; no agent works on this page yet.

Shell: max width ~1180px, 28px side padding. Persistent horizontal nav in mono, current page marked with a gold underline. Petrol-ink (--ink) top bar with the wordmark and a mono date/time stamp. Standard gaps 14–20px; section rhythm ~52px with 1px --line dividers. Alternate some sections onto --paper-warm bands, and place data displays on --surface white, so pages aren't flat. Two-column tool layouts collapse to one column under 820px.

## Components

Country multi-select (one or many; cannot deselect last) · indicator selector · interactive line chart (hover index tooltips; click year → year-in-focus panel) · budget pie (centre total, segment click → projects) · stat cards · insight callout · news feed (thumb + title + source/time + tag) with country filter · publications index (summary + link out) · deals headline list · CSV export button. (Analysis builder is deferred — see structure note.)

Pattern notes:
- **Eyebrow label:** mono · uppercase · teal · wide-tracked. The universal section opener.
- **Quick-link cards:** a 2px ink top rule, a mono index number, a Bricolage title, a muted one-line description. No box, no shadow — the rule frames it.
- **Stat / indicator:** small muted label + large Bricolage (or mono) value. Positive values --pos, neutral --ink. Group as a vertical hairline-divided list or a divided horizontal strip.
- **List rows (news, etc.):** hairline-divided; mono tag + title left, mono meta right; whole row is the target when interactive.
- **Charts:** faint gridlines, mono axis labels, ONE series in --teal, all others in the muted series palette at reduced opacity so the story reads instantly. Live/endpoint marker in --gold. Soft teal area-fill (~8%) under the lead line only. Sit charts on --surface white.

## Dynamic-Content Shells

Anything fed by live data (the daily briefing is the reference case) is built as a **content-agnostic shell with fixed slots**, so variable content can never break layout:

- Reserve space — clamp text to a line count (`-webkit-line-clamp`) and set a `min-height` so short and long content occupy the same footprint.
- Bind, don't place — secondary panels (e.g. a key-indicators rail) pull from the active entity's data, not hand-positioned values.
- Keep a clean data contract in the component logic that a backend can fill. Reference shape for the briefing:

  ```js
  {
    tag,        // entity / country label
    heading,    // clamps to 3 lines
    dek,        // subheading, clamps to ~3 lines
    source,     // attribution
    time,       // recency
    stats: [ { label, value, color } ]   // pulled for the active entity
  }
  ```

  Backend job: fetch → classify entity → summarise into those fields. The shell renders any valid instance without layout changes. Always design the empty/loading state too.

## Interactions

- Country dropdown: checkboxes, single or multiple; cannot deselect the last; chart, stats, legend update on change.
- Indicator selector: swaps metrics; chart title, subtitle, source label, insight update.
- Chart: hover index tooltips; click a year → year-in-focus panel shows that year's key event + headlines.
- Budget pie: hover segment for value; click segment → key projects/initiatives for that allocation.
- News: country filter chips; default shows all Caribbean.
- Analysis builder (deferred): would let a user set parameters → render a visualization → export (PNG / CSV). Not in this round.
- Export: any data selection downloads as CSV.

## Motion

Restrained and functional. One staggered fade-up per page load (eyebrow → heading → body). Charts animate in once. Subtle hover color shifts. No scroll-jacking, no marquees, no count-up drama. Respect prefers-reduced-motion.

(This is the project's final word on motion — see Explicitly Overridden for the generic skill's scroll-choreography defaults that don't apply here.)

## Quality Floor

Responsive to mobile · visible keyboard focus (2px --teal outline) · aria-labels on charts and icon-only controls · contrast checked on --ink-faint · all displayed numbers rounded · designed empty/error states.

## Planned (not yet built)

- An AI question agent embedded near the data so users can ask questions and explore findings conversationally. Same restrained styling; not a popup.
