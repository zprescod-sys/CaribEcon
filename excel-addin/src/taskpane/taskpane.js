/* global document, Excel, Office, fetch */

/* CaribEcon task pane — browse the hub, then drop a sourced series into the sheet.

   Reads the same snapshot the custom functions load (see ../shared/hub.js): with the shared
   runtime declared in manifest.xml, opening the pane costs no extra fetch once a formula has
   already warmed the hub, and vice versa.

   Design follows EDDESIGN.md — see taskpane.css. */

import {
  loadHub,
  hub,
  countryName,
  indicatorsFor,
  countriesWith,
  pointsInRange,
  findSeries,
  P_YEAR,
  P_VALUE,
  P_TYPE,
  P_VINTAGE,
} from '../shared/hub.js';

/* Shared with the server, not reimplemented: api/deepdive.ts builds the WorkbookPlan with these
   same rules, so the pane executes a layout it did not invent. Importing the TypeScript source
   directly is what webpack.config.js's .ts babel rule exists for — the alternative was a second
   copy of the sheet-naming and column-order logic, free to drift from the tested one. */
import { resolveSheetName, EVIDENCE_COLUMNS, SERIES_COLORS } from '../../../src/lib/excelOutputs';

const API_BASE = process.env.CARIBECON_API_BASE;
const RESEARCH_TOKEN = process.env.CARIBECON_RESEARCH_TOKEN;

const PREVIEW_ROWS = 8; // enough to show the shape of a series without scrolling the pane

const el = id => document.getElementById(id);

/* Everything rendered below comes from our own hub, but it is still interpolated into markup:
   source strings and editorial notes are free text, and sourceUrl is written unattended by
   scripts/refresh-data.mjs. Escaping at the boundary costs nothing and means a stray angle
   bracket in a citation can never become markup in a pane that holds ReadWriteDocument. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

// Only ever emit a link for a scheme a browser should follow.
function safeUrl(url) {
  return /^https?:\/\//i.test(String(url ?? '')) ? String(url) : null;
}

Office.onReady(async info => {
  if (info.host !== Office.HostType.Excel) {
    setStatus('This add-in runs in Excel.', true);
    return;
  }

  wireTabs();

  const data = await loadHub(API_BASE);
  if (!data) {
    setStatus(
      'Could not reach the CaribEcon hub. Check your connection and reopen the pane.',
      true,
    );
    return;
  }

  el('status').hidden = true;
  el('hub-version').textContent = `hub ${data.version}`;
  el('panel-browse').hidden = false;

  initBrowse();
  initDeepDive();
  renderReference();

  // The Ask tab only appears in a build that was given a research token — better a missing
  // tab than one that 401s on every question.
  if (RESEARCH_TOKEN) {
    el('tab-ask').hidden = false;
    initAsk();
  }
});

function setStatus(message, isError = false) {
  const node = el('status');
  node.hidden = false;
  node.textContent = message;
  node.classList.toggle('status--error', isError);
}

const PANELS = ['browse', 'deepdive', 'ask', 'reference'];

function wireTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) {
        other.classList.toggle('is-active', other === tab);
      }
      for (const name of PANELS) {
        el(`panel-${name}`).hidden = tab.dataset.panel !== name;
      }
    });
  }
}

// ── Browse ─────────────────────────────────────────────────────────────────────────────────

function initBrowse() {
  const h = hub();

  el('country').innerHTML = [...h.countries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`)
    .join('');

  // Changing country can invalidate the indicator, which can invalidate the year range,
  // so each step rebuilds the one below it.
  el('country').addEventListener('change', () => {
    fillIndicators();
    fillYears();
    renderPreview();
  });
  el('indicator').addEventListener('change', () => {
    fillYears();
    renderPreview();
  });
  el('year-from').addEventListener('change', () => {
    clampYears('from');
    renderPreview();
  });
  el('year-to').addEventListener('change', () => {
    clampYears('to');
    renderPreview();
  });

  el('insert-values').addEventListener('click', () => insert(writeValues));
  el('insert-formulas').addEventListener('click', () => insert(writeFormulas));

  // Guyana first if present — the widest, most complete series in the hub.
  if ([...el('country').options].some(o => o.value === 'GY')) el('country').value = 'GY';

  fillIndicators();
  fillYears();
  renderPreview();
}

// Only the indicators this economy actually carries, so a selection can never be a dead end.
function fillIndicators() {
  const h = hub();
  const code = el('country').value;
  const previous = el('indicator').value;
  const available = indicatorsFor(h, code);

  el('indicator').innerHTML = available
    .map(i => `<option value="${esc(i.slug)}">${esc(i.label)}</option>`)
    .join('');

  if (available.some(i => i.slug === previous)) {
    el('indicator').value = previous;
  }

  const total = h.indicators.length;
  el('indicator-hint').textContent =
    `${available.length} of ${total} indicators available for ${countryName(h, code)}.`;
}

function selected() {
  const h = hub();
  const country = el('country').value;
  const slug = el('indicator').value;
  const series = h.byKey.get(`${country}|${slug}`) ?? null;
  return { h, country, slug, series };
}

function fillYears() {
  const { series } = selected();
  const years = series ? series.p.filter(p => p[P_VALUE] !== null).map(p => p[P_YEAR]) : [];

  for (const id of ['year-from', 'year-to']) {
    el(id).innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join('');
  }
  if (years.length) {
    el('year-from').value = String(years[0]);
    el('year-to').value = String(years[years.length - 1]);
  }
}

// Keep the range coherent by pushing the *other* end, never silently discarding the user's pick.
function clampYears(changed) {
  const from = Number(el('year-from').value);
  const to = Number(el('year-to').value);
  if (from <= to) return;
  if (changed === 'from') el('year-to').value = String(from);
  else el('year-from').value = String(to);
}

function selectedRows() {
  const { series } = selected();
  if (!series) return [];
  return pointsInRange(series, Number(el('year-from').value), Number(el('year-to').value));
}

const fmt = n =>
  typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';

function renderPreview() {
  const { h, country, slug, series } = selected();
  const node = el('preview');

  if (!series) {
    node.innerHTML = `<p class="empty">No series for this combination.</p>`;
    setInsertEnabled(false);
    return;
  }

  const rows = selectedRows();
  if (!rows.length) {
    node.innerHTML = `<p class="empty">No sourced values in that year range.</p>`;
    setInsertEnabled(false);
    return;
  }

  const label = h.indicators.find(i => i.slug === slug)?.label ?? slug;
  const shown = rows.slice(0, PREVIEW_ROWS);
  const projected = rows.filter(p => p[P_TYPE] !== 'actual').length;

  const body = shown
    .map(
      p =>
        `<tr class="${p[P_TYPE] === 'actual' ? '' : 'is-projected'}">` +
        `<td>${p[P_YEAR]}</td><td>${fmt(p[P_VALUE])}</td></tr>`,
    )
    .join('');

  node.innerHTML = `
    <div class="preview__head">
      <h2 class="preview__title">${esc(label)}</h2>
      <p class="preview__meta">
        ${esc(countryName(h, country))} · ${esc(series.u)} · ${rows.length} year${rows.length === 1 ? '' : 's'}
        ${projected ? ` · ${projected} estimated or projected` : ''}
      </p>
    </div>
    <table class="preview__table">
      <thead><tr><th>Year</th><th>Value</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${rows.length > shown.length ? `<p class="preview__more">+ ${rows.length - shown.length} more</p>` : ''}
    ${provenanceHtml(series, rows)}
  `;
  setInsertEnabled(true);
}

// Every figure carries where it came from — this is the pane's version of that contract.
function provenanceHtml(series, rows) {
  const vintages = [...new Set(rows.map(p => p[P_VINTAGE]))].sort();
  const vintage =
    vintages.length > 1 ? `${vintages[0]}–${vintages[vintages.length - 1]}` : vintages[0];
  const url = safeUrl(series.url);
  const org = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(series.org)}</a>`
    : esc(series.org);
  return `
    <div class="provenance">
      <span class="provenance__tier">${esc(series.tier)}</span>${esc(series.src)}<br />
      Vintage ${esc(vintage)} · confidence ${esc(series.conf)}<br />
      ${org}
      ${series.note ? `<span class="provenance__note">${esc(series.note)}</span>` : ''}
    </div>
  `;
}

function setInsertEnabled(on) {
  el('insert-values').disabled = !on;
  el('insert-formulas').disabled = !on;
}

// ── Insert ─────────────────────────────────────────────────────────────────────────────────

async function insert(write) {
  const note = el('insert-note');
  try {
    setInsertEnabled(false);
    await Excel.run(async ctx => {
      await write(ctx);
      await ctx.sync();
    });
    note.textContent = 'Inserted at the selected cell.';
  } catch (error) {
    note.textContent = `Could not insert: ${error.message}`;
  } finally {
    setInsertEnabled(true);
  }
}

// Shared framing so both insert modes produce the same shape of block.
function blockHeader(h, country, slug, series) {
  const label = h.indicators.find(i => i.slug === slug)?.label ?? slug;
  return { label, subtitle: `${countryName(h, country)} · ${series.u}` };
}

function styleBlock(range, headerRow, label) {
  range.format.autofitColumns();
  headerRow.format.font.bold = true;
  headerRow.format.borders.getItem('EdgeBottom').style = 'Continuous';
  label.format.font.bold = true;
  label.format.font.size = 12;
  label.format.font.color = '#0E5E4E';
}

/* Static values plus a provenance footer — a self-contained, citable block that survives
   being emailed to someone without the add-in. */
async function writeValues(ctx) {
  const { h, country, slug, series } = selected();
  const rows = selectedRows();
  const { label, subtitle } = blockHeader(h, country, slug, series);
  const vintages = [...new Set(rows.map(p => p[P_VINTAGE]))].sort();

  const grid = [
    [label, ''],
    [subtitle, ''],
    ['Year', label],
    ...rows.map(p => [p[P_YEAR], p[P_VALUE]]),
    ['', ''],
    ['Source', series.src],
    ['Vintage', vintages.join(', ')],
    ['Source tier', series.tier],
    ['Confidence', series.conf],
    ['Retrieved from', series.url],
  ];

  const anchor = ctx.workbook.getSelectedRange().getCell(0, 0);
  const block = anchor.getResizedRange(grid.length - 1, 1);
  block.values = grid;

  // Year column as a plain integer; values with separators but no forced decimals, so a
  // percentage and a millions-of-dollars level both read correctly.
  const dataStart = 3;
  const dataRange = anchor.getOffsetRange(dataStart, 0).getResizedRange(rows.length - 1, 1);
  dataRange.numberFormat = rows.map(() => ['0', '#,##0.##']);

  const footer = anchor.getOffsetRange(dataStart + rows.length + 1, 0).getResizedRange(4, 1);
  footer.format.font.size = 9;
  footer.format.font.color = '#4C5A54';

  styleBlock(
    block,
    anchor.getOffsetRange(2, 0).getResizedRange(0, 1),
    anchor.getResizedRange(0, 1),
  );
}

/* Live formulas instead of values — the same block, but it re-resolves from the hub and shows
   the custom functions doing the work. CE.SERIES spills, so nothing is written below it. */
async function writeFormulas(ctx) {
  const { h, country, slug, series } = selected();
  const rows = selectedRows();
  const { label, subtitle } = blockHeader(h, country, slug, series);
  const from = Number(el('year-from').value);
  const to = Number(el('year-to').value);
  const args = `"${country}","${slug}"`;

  const head = [
    [label, ''],
    [subtitle, ''],
    ['Year', label],
  ];

  const anchor = ctx.workbook.getSelectedRange().getCell(0, 0);
  const headRange = anchor.getResizedRange(head.length - 1, 1);
  headRange.values = head;

  // One spilling formula covers every row of the series.
  anchor.getOffsetRange(3, 0).formulas = [[`=CE.SERIES(${args},${from},${to})`]];

  const footerTop = 3 + rows.length + 1;
  anchor.getOffsetRange(footerTop, 0).getResizedRange(2, 1).formulas = [
    ['Source', `=CE.SOURCE(${args},${to})`],
    ['Vintage', `=CE.VINTAGE(${args},${to})`],
    ['Unit', `=CE.UNIT(${args},${to})`],
  ];

  const footer = anchor.getOffsetRange(footerTop, 0).getResizedRange(2, 1);
  footer.format.font.size = 9;
  footer.format.font.color = '#4C5A54';

  styleBlock(
    headRange,
    anchor.getOffsetRange(2, 0).getResizedRange(0, 1),
    anchor.getResizedRange(0, 1),
  );
}

// ── Deep Dive ──────────────────────────────────────────────────────────────────────────────
// Phase 2a (plan §6, §9): explicit picker only — no Interpreter yet, so the form itself is the
// only intent source. Retrieval + compute happen server-side in api/deepdive.ts; this file only
// renders the response and writes it into the sheet. No chart insertion yet (see plan status).

const DEEPDIVE_MAX_INDICATORS = 3;
let deepDiveResult = null; // last successful /api/deepdive response, held for the Insert button

function initDeepDive() {
  const h = hub();

  el('dd-country').innerHTML = [...h.countries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<option value="${esc(c.code)}">${esc(c.name)}</option>`)
    .join('');

  el('dd-country').addEventListener('change', () => {
    fillDeepDiveIndicators();
    fillDeepDiveYears();
  });
  el('dd-generate').addEventListener('click', generateDeepDive);
  el('dd-insert').addEventListener('click', insertDeepDiveTable);
  el('dd-insert-report').addEventListener('click', insertDeepDiveReport);

  // Guyana first if present, same reasoning as Browse: the widest, most complete series.
  if ([...el('dd-country').options].some(o => o.value === 'GY')) el('dd-country').value = 'GY';

  fillDeepDiveIndicators();
  fillDeepDiveYears();
}

function fillDeepDiveIndicators() {
  const h = hub();
  const code = el('dd-country').value;
  const available = indicatorsFor(h, code);

  el('dd-indicators').innerHTML = available
    .map(i => `<option value="${esc(i.slug)}">${esc(i.label)}</option>`)
    .join('');

  // gdp_growth pre-selected when the economy carries it, so Generate produces something with
  // zero extra clicks — Deep Dive is meant to be one step further than Browse, not a colder start.
  if (available.some(i => i.slug === 'gdp_growth')) {
    for (const option of el('dd-indicators').options)
      option.selected = option.value === 'gdp_growth';
  }

  el('dd-indicator-hint').textContent =
    `${available.length} indicators available for ${countryName(h, code)}. ` +
    `Ctrl/Cmd-click to select up to ${DEEPDIVE_MAX_INDICATORS}.`;
}

// No single series to derive a range from once more than one indicator can be picked, so this
// seeds from one representative series (gdp_growth, or whatever the economy carries first) as a
// sane starting point — api/deepdive.ts still checks real per-indicator coverage regardless and
// reports a miss for anything outside it, so a stale default here can under-select, never lie.
function fillDeepDiveYears() {
  const h = hub();
  const code = el('dd-country').value;
  const available = indicatorsFor(h, code);
  const seedSlug = available.some(i => i.slug === 'gdp_growth') ? 'gdp_growth' : available[0]?.slug;
  const series = seedSlug ? findSeries(h, code, seedSlug) : null;
  const years = series ? series.p.filter(p => p[P_VALUE] !== null).map(p => p[P_YEAR]) : [];

  if (years.length) {
    el('dd-year-from').value = String(years[0]);
    el('dd-year-to').value = String(years[years.length - 1]);
  }
}

function selectedDeepDiveIndicators() {
  return [...el('dd-indicators').selectedOptions]
    .map(o => o.value)
    .slice(0, DEEPDIVE_MAX_INDICATORS);
}

async function generateDeepDive() {
  const h = hub();
  const country = el('dd-country').value;
  const indicators = selectedDeepDiveIndicators();
  const yearFrom = el('dd-year-from').value ? Number(el('dd-year-from').value) : null;
  const yearTo = el('dd-year-to').value ? Number(el('dd-year-to').value) : null;

  const out = el('dd-preview');
  deepDiveResult = null;
  el('dd-insert-actions').hidden = true;
  el('dd-insert-note').textContent = '';

  if (!indicators.length) {
    out.innerHTML = `<p class="empty">Select at least one indicator.</p>`;
    return;
  }

  el('dd-generate').disabled = true;
  out.innerHTML = `<p class="empty">Retrieving…</p>`;

  try {
    const res = await fetch(`${API_BASE}/api/deepdive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country, indicators, yearFrom, yearTo }),
    });
    const body = await res.json();

    if (!res.ok) {
      out.innerHTML = `<p class="empty">${esc(body.misses?.[0]?.detail ?? `Request failed (${res.status}).`)}</p>`;
      return;
    }

    deepDiveResult = { h, body };
    renderDeepDivePreview(body);
  } catch (error) {
    out.innerHTML = `<p class="empty">Could not reach the deep dive endpoint: ${esc(error.message)}</p>`;
  } finally {
    el('dd-generate').disabled = false;
  }
}

function renderDeepDivePreview(body) {
  const out = el('dd-preview');
  const entries = Object.entries(body.indicators);

  if (!entries.length) {
    out.innerHTML =
      `<p class="empty">No sourced data for this selection.</p>` + missesHtml(body.misses);
    return;
  }

  out.innerHTML =
    entries.map(([, result]) => deepDiveIndicatorHtml(result)).join('') + missesHtml(body.misses);
  el('dd-insert-actions').hidden = false;
}

function deepDiveIndicatorHtml({ evidence, periodAverage }) {
  const rows = evidence.points.filter(p => p.value !== null);
  const shown = rows.slice(0, PREVIEW_ROWS);
  const projected = rows.filter(p => p.type !== 'actual').length;

  const tbody = shown
    .map(
      p =>
        `<tr class="${p.type === 'actual' ? '' : 'is-projected'}">` +
        `<td>${p.year}</td><td>${fmt(p.value)}</td></tr>`,
    )
    .join('');

  return `
    <div class="preview__head">
      <h2 class="preview__title">${esc(evidence.label)}</h2>
      <p class="preview__meta">
        ${esc(evidence.unit)} · ${rows.length} year${rows.length === 1 ? '' : 's'}
        ${projected ? ` · ${projected} estimated or projected` : ''}
        ${periodAverage.value !== null ? ` · period average ${fmt(periodAverage.value)}` : ''}
      </p>
    </div>
    <table class="preview__table">
      <thead><tr><th>Year</th><th>Value</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    ${rows.length > shown.length ? `<p class="preview__more">+ ${rows.length - shown.length} more</p>` : ''}
    ${deepDiveProvenanceHtml(evidence)}
  `;
}

// Mirrors provenanceHtml() above, but reads DataEvidence's field names (askTools.ts) rather
// than the hub snapshot's short wire keys — the two are deliberately different shapes, this
// endpoint returns server-computed evidence, not a raw hub series.
function deepDiveProvenanceHtml(evidence) {
  const url = safeUrl(evidence.sourceUrl);
  const org = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(evidence.sourceOrg)}</a>`
    : esc(evidence.sourceOrg);
  return `
    <div class="provenance">
      <span class="provenance__tier">${esc(evidence.sourceTier)}</span>${esc(evidence.source)}<br />
      Vintage ${esc(evidence.vintage)} · confidence ${esc(evidence.confidence)}<br />
      ${org}
      ${evidence.note ? `<span class="provenance__note">${esc(evidence.note)}</span>` : ''}
    </div>
  `;
}

function missesHtml(misses) {
  if (!misses?.length) return '';
  return `<div class="provenance"><span class="provenance__note">${misses
    .map(m => esc(m.detail))
    .join('<br />')}</span></div>`;
}

async function insertDeepDiveTable() {
  if (!deepDiveResult) return;
  const note = el('dd-insert-note');
  try {
    el('dd-insert').disabled = true;
    await Excel.run(async ctx => {
      let anchor = ctx.workbook.getSelectedRange().getCell(0, 0);
      for (const result of Object.values(deepDiveResult.body.indicators)) {
        anchor = writeDeepDiveBlock(anchor, result);
      }
      await ctx.sync();
    });
    note.textContent = 'Inserted at the selected cell.';
  } catch (error) {
    note.textContent = `Could not insert: ${error.message}`;
  } finally {
    el('dd-insert').disabled = false;
  }
}

/* One indicator's block, same shape as writeValues() above: static values plus a provenance
   footer. Returns the anchor cell for the NEXT block, two rows below this one's end — queues
   the write against the batch (no sync here; the caller syncs once after every block). */
function writeDeepDiveBlock(anchor, { evidence, periodAverage }) {
  const rows = evidence.points.filter(p => p.value !== null);
  const vintages = [...new Set(rows.map(p => p.vintage))].sort();

  const grid = [
    [evidence.label, ''],
    [`${evidence.country} · ${evidence.unit}`, ''],
    ['Year', evidence.label],
    ...rows.map(p => [p.year, p.value]),
    ['', ''],
    ['Period average', periodAverage.value],
    ['Source', evidence.source],
    ['Vintage', vintages.join(', ')],
    ['Source tier', evidence.sourceTier],
    ['Confidence', evidence.confidence],
    ['Retrieved from', evidence.sourceUrl],
  ];

  const block = anchor.getResizedRange(grid.length - 1, 1);
  block.values = grid;

  const dataStart = 3;
  const dataRange = anchor.getOffsetRange(dataStart, 0).getResizedRange(rows.length - 1, 1);
  dataRange.numberFormat = rows.map(() => ['0', '#,##0.##']);

  const footer = anchor.getOffsetRange(dataStart + rows.length + 1, 0).getResizedRange(4, 1);
  footer.format.font.size = 9;
  footer.format.font.color = '#4C5A54';

  styleBlock(
    block,
    anchor.getOffsetRange(2, 0).getResizedRange(0, 1),
    anchor.getResizedRange(0, 1),
  );

  return anchor.getOffsetRange(grid.length + 1, 0);
}

/* ── Insert report ───────────────────────────────────────────────────────────────────────────
   Executes the WorkbookPlan api/deepdive.ts computed (plan §6 step 6). Every coordinate, heading
   and cell value below comes from the plan; this function decides none of them. That split is
   the point — the layout is unit-tested server-side in src/lib/excelOutputs.test.mjs, and the
   part that can only be checked by opening Excel is kept as thin as possible.

   Writes to NEW sheets, never into an existing one (plan §5). */

// Series formatting and explicit category axes need ExcelApi 1.7; manifest.xml only requires
// SharedRuntime 1.1, so the richer calls are feature-detected. Without 1.7 the chart still
// renders — it just falls back to Excel's default colour and an index-numbered category axis.
function supportsRichCharts() {
  try {
    return Office.context.requirements.isSetSupported('ExcelApi', '1.7');
  } catch {
    return false;
  }
}

// Office.js writes a JS null as an empty cell, but being explicit keeps a hub gap unmistakably
// blank rather than risking a coerced 0 — the distinction the whole data policy rests on.
function cellValues(rows) {
  return rows.map(row => row.map(value => (value === null || value === undefined ? '' : value)));
}

function writeTableSection(sheet, section) {
  const top = section.startRow;
  const block = sheet.getRangeByIndexes(top, 0, section.rowCount, section.columnCount);
  block.values = cellValues(section.rows);

  // Year as a plain integer; values and changes with separators but no forced decimals, so a
  // percentage and a millions-of-dollars level both read correctly — same rule as writeValues().
  if (section.dataRowCount > 0) {
    const data = sheet.getRangeByIndexes(
      top + section.firstDataRowOffset,
      0,
      section.dataRowCount,
      section.columnCount,
    );
    data.numberFormat = Array.from({ length: section.dataRowCount }, () => [
      '0',
      '#,##0.##',
      '#,##0.##',
    ]);
  }

  const title = sheet.getRangeByIndexes(top + section.titleRowOffset, 0, 1, section.columnCount);
  title.format.font.bold = true;
  title.format.font.size = 12;
  title.format.font.color = '#0E5E4E';

  const header = sheet.getRangeByIndexes(top + section.headerRowOffset, 0, 1, section.columnCount);
  header.format.font.bold = true;
  header.format.borders.getItem('EdgeBottom').style = 'Continuous';

  for (const offset of section.summaryRowOffsets) {
    sheet.getRangeByIndexes(top + offset, 0, 1, section.columnCount).format.font.bold = true;
  }
}

function writeListSection(sheet, section) {
  const heading = sheet.getRangeByIndexes(section.startRow, 0, 1, 1);
  heading.values = [[section.heading]];
  heading.format.font.bold = true;
  heading.format.font.color = '#0E5E4E';

  if (!section.rows.length) return;

  const body = sheet.getRangeByIndexes(
    section.startRow + 1,
    0,
    section.rows.length,
    section.columnCount,
  );
  // Pad short rows: Office.js requires every row of a values array to match the range width.
  body.values = section.rows.map(row => {
    const padded = row.slice(0, section.columnCount);
    while (padded.length < section.columnCount) padded.push('');
    return padded;
  });
  body.format.font.size = 9;
  body.format.font.color = '#4C5A54';
}

function addChart(sheet, placement, index, rich) {
  const { spec } = placement;

  /* Source is the VALUE column only, header row included so Excel names the series from it.
     Passing the year column too would make Excel plot the years as a second numeric series
     rather than reading them as categories — the axis is set explicitly below instead. */
  const source = sheet.getRangeByIndexes(
    placement.sourceStartRow,
    placement.sourceValueColumn,
    placement.sourceRowCount,
    1,
  );

  const chart = sheet.charts.add(Excel.ChartType.line, source, Excel.ChartSeriesBy.columns);
  chart.setPosition(
    sheet.getRangeByIndexes(placement.row, placement.column, 1, 1),
    sheet.getRangeByIndexes(
      placement.row + placement.heightRows,
      placement.column + placement.widthColumns,
      1,
      1,
    ),
  );
  chart.title.text = spec.title;
  chart.axes.valueAxis.title.text = spec.unit;
  chart.legend.visible = false; // one series per chart, so a legend only repeats the title

  if (!rich) return;
  const series = chart.series.getItemAt(0);
  // Categories exclude the header row, hence the +1 / -1.
  series.setXAxisValues(
    sheet.getRangeByIndexes(placement.sourceStartRow + 1, 0, placement.sourceRowCount - 1, 1),
  );
  series.format.line.color = SERIES_COLORS[index % SERIES_COLORS.length];
}

function writeEvidenceSheet(sheet, plan) {
  const header = plan.evidenceHeader;
  // Read each cell by the key EVIDENCE_COLUMNS declares, so the body can never fall out of step
  // with the header order the same constant produced.
  const rows = plan.evidenceRows.map(row => EVIDENCE_COLUMNS.map(([key]) => row[key]));

  const all = cellValues([header, ...rows]);
  sheet.getRangeByIndexes(0, 0, all.length, header.length).values = all;

  const headerRange = sheet.getRangeByIndexes(0, 0, 1, header.length);
  headerRange.format.font.bold = true;
  headerRange.format.borders.getItem('EdgeBottom').style = 'Continuous';
  sheet.getRangeByIndexes(0, 0, all.length, header.length).format.autofitColumns();
}

async function insertDeepDiveReport() {
  if (!deepDiveResult) return;
  const plan = deepDiveResult.body.workbookPlan;
  const note = el('dd-insert-note');

  if (!plan || !plan.sections.some(s => s.kind === 'table')) {
    note.textContent = 'Nothing to write — this result has no sourced series.';
    return;
  }

  try {
    el('dd-insert-report').disabled = true;
    note.textContent = 'Writing the report…';

    const rich = supportsRichCharts();

    await Excel.run(async ctx => {
      const sheets = ctx.workbook.worksheets;
      sheets.load('items/name');
      await ctx.sync();

      // Resolve against the real workbook, and resolve the Evidence name against the report
      // name too so the two new sheets cannot collide with each other.
      const existing = sheets.items.map(s => s.name);
      const reportName = resolveSheetName(plan.sheetName, existing);
      const evidenceName = resolveSheetName(plan.evidenceSheetName, [...existing, reportName]);

      const report = sheets.add(reportName);
      for (const section of plan.sections) {
        if (section.kind === 'table') writeTableSection(report, section);
        else writeListSection(report, section);
      }
      plan.charts.forEach((placement, i) => addChart(report, placement, i, rich));
      report.getRange('A:C').format.autofitColumns();

      writeEvidenceSheet(sheets.add(evidenceName), plan);

      report.activate();
      await ctx.sync();

      note.textContent =
        `Wrote "${reportName}" with ${plan.charts.length} chart` +
        `${plan.charts.length === 1 ? '' : 's'}, and "${evidenceName}" with ` +
        `${plan.evidenceRows.length} lineage rows.`;
    });
  } catch (error) {
    note.textContent = `Could not write the report: ${error.message}`;
  } finally {
    el('dd-insert-report').disabled = false;
  }
}

// ── Ask ────────────────────────────────────────────────────────────────────────────────────

function initAsk() {
  el('ask').addEventListener('click', ask);
  // Ctrl/Cmd+Enter submits — Enter alone still adds a newline, since questions run long.
  el('question').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) ask();
  });
}

async function ask() {
  const question = el('question').value.trim();
  if (!question) return;

  const out = el('answer');
  el('ask').disabled = true;
  out.innerHTML = `<p class="answer__working">Reading the hub…</p>`;

  try {
    const res = await fetch(`${API_BASE}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CaribEcon-Token': RESEARCH_TOKEN },
      body: JSON.stringify({ question }),
    });
    const body = await res.json();

    if (!res.ok) {
      out.innerHTML = `<p class="answer__working">${esc(body.message ?? `Request failed (${res.status}).`)}</p>`;
      return;
    }
    renderAnswer(question, body);
  } catch (error) {
    out.innerHTML = `<p class="answer__working">Could not reach the research endpoint: ${esc(error.message)}</p>`;
  } finally {
    el('ask').disabled = false;
  }
}

/* Minimal Markdown: paragraphs and bold only. Escaping runs first, so the model's output is
   inert text before any markup is reintroduced — and only these two forms ever are. */
function renderMarkdown(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map(
      block =>
        `<p>${block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

function renderAnswer(question, body) {
  const cites = body.citations ?? [];
  const citeHtml = cites.length
    ? `<div class="cites">
         <p class="cites__label">Sources read (${cites.length})</p>
         ${cites
           .map(c => {
             const url = safeUrl(c.sourceUrl);
             const org = url
               ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.sourceOrg)}</a>`
               : esc(c.sourceOrg);
             return `<div class="cite"><b>${esc(c.country)} · ${esc(c.label)}</b><br />${org} · ${esc(c.sourceTier)} · vintage ${esc(c.vintage)}</div>`;
           })
           .join('')}
       </div>`
    : `<div class="cites"><p class="cites__label">Sources read (0)</p>
         <div class="cite">No hub series matched — the answer above reports what is missing.</div>
       </div>`;

  el('answer').innerHTML = `
    <div class="answer__body">${renderMarkdown(body.answer)}</div>
    ${citeHtml}
    <div class="answer__body" style="border-top:1px solid var(--line)">
      <button class="btn" type="button" id="insert-answer">Insert answer and sources</button>
    </div>
  `;

  el('insert-answer').addEventListener('click', () => insertAnswer(question, body));
}

// Writes the question, the answer, and the audit trail — so the sheet carries the reasoning,
// not just a number someone has to take on trust.
async function insertAnswer(question, body) {
  const rows = [
    ['CaribEcon research', ''],
    ['Question', question],
    ['Answer', body.answer],
    ['', ''],
    ['Sources read', String((body.citations ?? []).length)],
    ...(body.citations ?? []).map(c => [
      `${c.country} · ${c.label}`,
      `${c.sourceOrg} · ${c.sourceTier} · vintage ${c.vintage} · ${c.sourceUrl}`,
    ]),
  ];

  try {
    await Excel.run(async ctx => {
      const anchor = ctx.workbook.getSelectedRange().getCell(0, 0);
      const block = anchor.getResizedRange(rows.length - 1, 1);
      block.values = rows;
      block.format.autofitColumns();
      anchor.getResizedRange(0, 1).format.font.bold = true;
      anchor.getResizedRange(0, 1).format.font.color = '#0E5E4E';
      await ctx.sync();
    });
    el('insert-answer').textContent = 'Inserted at the selected cell';
  } catch (error) {
    el('insert-answer').textContent = `Could not insert: ${error.message}`;
  }
}

// ── Reference ──────────────────────────────────────────────────────────────────────────────

const FUNCTIONS = [
  ['GDP', 'country, year', 'Nominal GDP in local-currency units.', '=CE.GDP("GY", 2024)'],
  ['GDPGROWTH', 'country, year', 'Real GDP growth, percent.', '=CE.GDPGROWTH("TT", 2024)'],
  [
    'INDICATOR',
    'country, slug, year',
    'Any stored indicator, by slug.',
    '=CE.INDICATOR("BB", "inflation", 2024)',
  ],
  [
    'SERIES',
    'country, slug, [from], [to]',
    'A whole time series — spills as year and value columns.',
    '=CE.SERIES("GY", "gdp_growth", 2015, 2025)',
  ],
  [
    'SOURCE',
    'country, slug, year',
    'The citation behind a value.',
    '=CE.SOURCE("GY", "nominal_gdp", 2024)',
  ],
  [
    'VINTAGE',
    'country, slug, year',
    'Which data release the figure came from.',
    '=CE.VINTAGE("GY", "nominal_gdp", 2024)',
  ],
  [
    'UNIT',
    'country, slug, year',
    'The unit a value is expressed in.',
    '=CE.UNIT("GY", "nominal_gdp", 2024)',
  ],
];

function renderReference() {
  const h = hub();

  el('fn-list').innerHTML = FUNCTIONS.map(
    ([name, params, desc, eg]) => `
      <div class="fn">
        <p class="fn__sig"><b>CE.${esc(name)}</b>(${esc(params)})</p>
        <p class="fn__desc">${esc(desc)}</p>
        <p class="fn__eg">${esc(eg)}</p>
      </div>`,
  ).join('');

  el('slug-list').innerHTML = h.indicators
    .map(i => {
      const n = countriesWith(h, i.slug).length;
      return `<div class="ref-row"><code>${esc(i.slug)}</code><span>${n}/${h.countries.length}</span></div>`;
    })
    .join('');

  el('code-list').innerHTML = [...h.countries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<div class="ref-row"><code>${esc(c.code)}</code><span>${esc(c.name)}</span></div>`)
    .join('');
}
