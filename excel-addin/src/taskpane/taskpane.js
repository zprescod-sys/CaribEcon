/* global document, Excel, Office */

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
  P_YEAR,
  P_VALUE,
  P_TYPE,
  P_VINTAGE,
} from '../shared/hub.js';

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
    setStatus('Could not reach the CaribEcon hub. Check your connection and reopen the pane.', true);
    return;
  }

  el('status').hidden = true;
  el('hub-version').textContent = `hub ${data.version}`;
  el('panel-browse').hidden = false;

  initBrowse();
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

const PANELS = ['browse', 'ask', 'reference'];

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
  const vintage = vintages.length > 1 ? `${vintages[0]}–${vintages[vintages.length - 1]}` : vintages[0];
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

  styleBlock(block, anchor.getOffsetRange(2, 0).getResizedRange(0, 1), anchor.getResizedRange(0, 1));
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

  styleBlock(headRange, anchor.getOffsetRange(2, 0).getResizedRange(0, 1), anchor.getResizedRange(0, 1));
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
    .map(block => `<p>${block.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br />')}</p>`)
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
  ['INDICATOR', 'country, slug, year', 'Any stored indicator, by slug.', '=CE.INDICATOR("BB", "inflation", 2024)'],
  ['SERIES', 'country, slug, [from], [to]', 'A whole time series — spills as year and value columns.', '=CE.SERIES("GY", "gdp_growth", 2015, 2025)'],
  ['SOURCE', 'country, slug, year', 'The citation behind a value.', '=CE.SOURCE("GY", "nominal_gdp", 2024)'],
  ['VINTAGE', 'country, slug, year', 'Which data release the figure came from.', '=CE.VINTAGE("GY", "nominal_gdp", 2024)'],
  ['UNIT', 'country, slug, year', 'The unit a value is expressed in.', '=CE.UNIT("GY", "nominal_gdp", 2024)'],
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
