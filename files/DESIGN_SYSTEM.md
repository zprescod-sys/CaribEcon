# DESIGN_SYSTEM.md — Caribbean Macro Almanac

The visual contract for this project. Read before any UI work. Derive every color, type, and spacing decision from here.

## Thesis

A multi-page Caribbean macroeconomic research tool with the register of a research institute, not a consumer app. Hard-edged and precise — angular geometry, no soft rounded corners. The data is the hero. Distinctive through typography, structure, and disciplined color, not decoration.

This is a portfolio-grade piece: it should look professional and near-perfect, the kind of project that stands on a GitHub repo and a LinkedIn post as evidence of connecting a real economic problem to a real workflow. Build to that bar.

Avoid the three AI-default looks: warm-cream + serif + terracotta; near-black + one acid accent; generic newspaper broadsheet.

## Color

Use as CSS variables. Cool paper base, deep petrol ink, marine teal brand, gold signal accent. Add muted color so it doesn't read as all-white — use tinted surfaces and section accents, never bright fills.

- --paper      #ECEEE8  page background (cool off-white)
- --paper-warm #E6E9E0  alternate section band (subtle tint, for striping pages)
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

Chart / category series palette (muted, designed — never neon, never rainbow):
teal #0E5E4E · gold #BC8A2E · navy #1E3A5F · clay #A8542E · plum #6A4A6E · slate #5A6B6E · moss #5C6B3A · rust #9A5B2E

## Typography

- Display: Bricolage Grotesque (700/800) — page titles, section headings, stat values, story titles.
- Body / UI: Hanken Grotesk (400/500/600) — paragraphs, controls, labels.
- Data / mono: JetBrains Mono (400/500) — eyebrows, axis ticks, sources, timestamps, nav, the ticker.

Scale: page title clamp(34–52px) lh 1.0 · section 28–30px · card/story title 17–19px · body 16px lh 1.6 · caption/mono 11–13px.
Sentence case everywhere. Two body weights only (400, 500). Tabular numerals for all data.

## Geometry — Hard Edges

- Border radius: 0 on cards, panels, buttons, inputs, chart containers, nav items. Square corners are the signature.
- Exception: pure circles only (legend dots, live point, pie segments). Nothing else is rounded.
- Borders: 1px solid --line. Use a 3px left border in --teal or --gold to mark emphasis blocks.
- Flat surfaces. No drop shadows except a functional square offset shadow on open dropdowns/menus.

## Multi-Page Structure

This is NOT a landing page. Separate pages, shared shell (top bar + persistent nav). Every page pulls from the same data hub (see CLAUDE.md). Pages:

1. Home — daily briefing (one story of the day, generalist, not country-specific) + regional indexed-GDP visual + quick links into each section.
2. Data — interactive chart explorer (country multi-select, indicator selector, year-in-focus panel, stat cards, insight callout) + CSV export of any selection + budget view: a pie chart with total budget in the centre, allocation breakdown, and key projects/initiatives shown under the pie or on segment click. Mirror the budget treatment for FDI and for government spending vs tax revenue.
3. News — all Caribbean news by default, filterable by individual country.
4. Publications — a browsable INDEX of reports from major bodies (IMF Article IV consultations, World Bank, regional institutions). Store title, body, type, date, your own short summary, and a link to the source. Host nothing — link out. Never embed the PDFs or reproduce report charts/tables.
5. Deals & Investment — headline M&A, transactions, and FDI activity. Headlines only, no deep specifics.
6. Analysis (client-facing) — DEFERRED, not built this round, but kept in the architecture: users specify exactly the data and parameters they want and generate their own chart, table, or visualization for export. Build the data hub and chart components so they could feed this later; no agent works on this page yet.

Shell: max width ~1180px, 28px side padding. Persistent horizontal nav in mono, current page marked with a gold underline. Standard gaps 14–20px; section rhythm ~52px with 1px --line dividers. Alternate some sections onto --paper-warm bands so pages aren't flat white. Two-column tool layouts collapse to one column under 820px.

## Components

Country multi-select (one or many; cannot deselect last) · indicator selector · interactive line chart (hover index tooltips; click year → year-in-focus panel) · budget pie (centre total, segment click → projects) · stat cards · insight callout · news feed (thumb + title + source/time + tag) with country filter · publications index (summary + link out) · deals headline list · CSV export button. (Analysis builder is deferred — see structure note.)

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

## Quality Floor

Responsive to mobile · visible keyboard focus (2px --teal outline) · aria-labels on charts and icon-only controls · contrast checked on --ink-faint · all displayed numbers rounded · designed empty/error states.

## Planned (not yet built)

- An AI question agent embedded near the data so users can ask questions and explore findings conversationally. Same restrained styling; not a popup.
