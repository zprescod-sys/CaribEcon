# SCREENSHOT_WORKFLOW.md — Visual Verification

How Fable verifies UI work visually. Use after any visual change, before committing.

## Setup (already done)

- `puppeteer` is a devDependency (`npm install` fetches it, Chrome included).
- `screenshot.mjs` lives in the project root. Use it as-is — don't rewrite it per task.
- Output goes to `./temporary screenshots/` (gitignored, auto-created).

## Taking a screenshot

1. Make sure the dev server is running (`npm run dev`) and note the port Astro prints —
   default is `4321`, but it auto-increments (`4322`, `4323`…) if the port is taken.
2. Screenshot the page you changed:

   ```bash
   node screenshot.mjs http://localhost:4321/data
   node screenshot.mjs http://localhost:4321/data after-pie-redesign   # optional label
   ```

3. Files save as `temporary screenshots/screenshot-N.png` (auto-incremented, never
   overwritten; label appends as `screenshot-N-label.png`). The script prints the path.
4. Read the PNG with the Read tool — the image can be inspected directly.
5. The script waits ~1.2s after load so D3 entrance animations settle, and captures the
   full page at 2x scale so hairlines and small mono type are inspectable.

## What to check (per DESIGN_SYSTEM.md)

Be specific when comparing — "stat value is 28px but the snapshot lead should be 44px",
"gap between legend rows is 6px but should be ~10px" — not "looks off".

- **Geometry**: border-radius 0 everywhere except pure circles (legend dots, pie segments,
  live points). Any rounded card/button/input corner is a bug.
- **Color**: every fill/stroke traceable to tokens.css — paper `#ECEEE8`, card `#F6F7F2`,
  ink `#0F231E`, teal `#0E5E4E`, gold `#BC8A2E`, pos `#2F7D5B`, neg `#B4543E`. No neon,
  no off-palette hexes.
- **Typography**: Bricolage Grotesque for display/stat values, Hanken Grotesk for body,
  JetBrains Mono for eyebrows/ticks/sources/ticker. Tabular numerals on all data. Scale:
  page title 34–52px · section 28–30px · body 16px · caption/mono 11–13px.
- **Spacing**: 14–20px standard gaps, ~52px section rhythm, 1px `--line` hairlines.
- **Data integrity surface**: estimate/projection flags visible wherever non-actuals
  render (gold dots, dashed segments, quiet lowercase flags); source lines present.
- **States**: no empty panels without a designed prompt; deltas carry context ("vs 2024").

## Housekeeping

- `temporary screenshots/` is disposable — never committed, safe to clear.
- Compare before/after by screenshotting with labels (`before-x`, `after-x`) and reading
  both PNGs side by side.
