/* Contract tests for the deterministic Excel output planner (src/lib/excelOutputs.ts) —
 * plan §10 requires "calculation registry plus ChartSpec and WorkbookPlan validation".
 *
 * The load-bearing assertion in this file is the traceability one near the bottom: every number
 * the plan would write into a workbook must reconcile to a retrieved evidence point or to a
 * calculation whose inputYears name real retrieved years. That is the anti-fabrication check —
 * a plan that invented a figure would still render perfectly well in Excel, so nothing else
 * catches it.
 *
 * Fixtures are hand-built rather than pulled from the live hub: this module is pure and its
 * behaviour must not shift when the monthly data refresh moves a number. The endpoint tests in
 * api/deepdive.test.mjs cover it against real data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChartSpecification,
  buildWorkbookPlan,
  resolveSheetName,
  calculationForUnit,
  evidenceId,
  EVIDENCE_COLUMNS,
  SOURCE_SUMMARY_COLUMNS,
  seriesIdentifier,
  SERIES_COLORS,
  numberFormatForUnit,
} from './excelOutputs.ts';
import { yoy_change, pp_change, period_average } from './calculations.ts';

const point = (year, value, type = 'actual') => ({ year, value, type });

function evidence(over = {}) {
  return {
    country: 'GY',
    indicator: 'gdp_growth',
    label: 'GDP Growth Rate',
    unit: '%',
    source: 'IMF WEO April 2026',
    sourceOrg: 'IMF',
    sourceTier: 'comparable',
    sourceUrl: 'https://www.imf.org/external/datamapper/NGDP_RPCH',
    vintage: '2026-04',
    confidence: 'high',
    points: [point(2020, 43.5), point(2021, 20.1), point(2022, 62.3)],
    ...over,
  };
}

// Mirrors what api/deepdive.ts will assemble per indicator.
function result(ev = evidence()) {
  const name = calculationForUnit(ev.unit);
  const fn = name === 'pp_change' ? pp_change : yoy_change;
  return {
    evidence: ev,
    periodAverage: period_average(ev.points),
    change: { name, results: fn(ev.points) },
  };
}

// A real evidenceId is "<country>:<indicator>" (excelOutputs.ts:44). Without this, a test like
// "every chart ID exists in known IDs" would pass vacuously if evidenceId() ever degraded to
// undefined on both sides — Set.has(undefined) is true when undefined was itself pushed into the
// set. Asserting the shape closes that fail-open hole.
function assertRealEvidenceId(id) {
  assert.equal(typeof id, 'string', `evidence ID must be a string, got ${typeof id}`);
  const [country, ...rest] = id.split(':');
  assert.ok(country && rest.join(':'), `evidence ID "${id}" is not "<country>:<indicator>"`);
}

const intent = (over = {}) => ({
  workflow: 'single_country',
  country: 'GY',
  indicators: ['gdp_growth'],
  yearFrom: null,
  yearTo: null,
  outputs: { table: true, charts: true, explanation: false },
  ...over,
});

// ── seriesIdentifier ───────────────────────────────────────────────────────────────────────

test('seriesIdentifier extracts a World Bank WDI code, dots and all', () => {
  const id = seriesIdentifier({
    source: 'World Bank — World Development Indicators (NY.GDP.MKTP.CN)',
    sourceUrl: 'https://api.worldbank.org/v2/country/JAM/indicator/NY.GDP.MKTP.CN?format=json',
  });
  assert.equal(id, 'NY.GDP.MKTP.CN');
});

test('seriesIdentifier extracts an IMF WEO code, including the underscore', () => {
  // Regression: an earlier version of this regex excluded "_" from its character class, which
  // would have silently truncated or dropped every WEO code — every real WEO code carries one
  // (GGXWDG_NGDP, NGDP_RPCH), unlike WDI's dot-only codes.
  const id = seriesIdentifier({
    source: 'IMF World Economic Outlook (DataMapper)',
    sourceUrl: 'https://www.imf.org/external/datamapper/GGXWDG_NGDP/GUY',
  });
  assert.equal(id, 'GGXWDG_NGDP');
});

test('seriesIdentifier falls back to a parenthetical code when the URL itself carries none', () => {
  const id = seriesIdentifier({
    source: 'World Bank WDI series (NY.GDP.MKTP.KD.ZG)',
    sourceUrl: 'https://data.worldbank.org/some-landing-page',
  });
  assert.equal(id, 'NY.GDP.MKTP.KD.ZG');
});

test('seriesIdentifier returns null for a hand-collected primary source, never a fabricated code', () => {
  const id = seriesIdentifier({
    source: 'T&T Ministry of Finance — Review of the Economy 2025',
    sourceUrl: 'https://www.finance.gov.tt/category/economic-review/',
  });
  assert.equal(id, null);
});

test('seriesIdentifier does not mistake a tool name in parentheses for a code', () => {
  const id = seriesIdentifier({
    source: 'IMF World Economic Outlook (DataMapper)',
    sourceUrl: 'https://www.imf.org/external/datamapper/', // no code in the path this time
  });
  assert.equal(id, null, '"DataMapper" must not match the parenthetical fallback');
});

// ── Unit gating ────────────────────────────────────────────────────────────────────────────

test('calculationForUnit routes rates to pp_change and levels to yoy_change', () => {
  assert.equal(calculationForUnit('%'), 'pp_change');
  assert.equal(calculationForUnit(' % '), 'pp_change', 'unit strings are trimmed before matching');
  assert.equal(calculationForUnit('GY$ mn'), 'yoy_change');
  assert.equal(calculationForUnit('US$ mn'), 'yoy_change');
  assert.equal(calculationForUnit('persons'), 'yoy_change');
  assert.equal(calculationForUnit('months'), 'yoy_change');
});

test('the change column is labelled for the calculation that produced it', () => {
  const rate = buildWorkbookPlan([result()], intent()).sections.find(s => s.kind === 'table');
  assert.equal(rate.header[2], 'Change (pp)');

  const level = buildWorkbookPlan(
    [result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' }))],
    intent({ indicators: ['nominal_gdp'] }),
  ).sections.find(s => s.kind === 'table');
  assert.equal(level.header[2], 'Change (%)');
});

// ── Evidence IDs ───────────────────────────────────────────────────────────────────────────

test('evidenceId is stable and derived from identity, not position', () => {
  assert.equal(evidenceId('GY', 'gdp_growth'), 'GY:gdp_growth');
  assert.equal(evidenceId('GY', 'gdp_growth'), evidenceId('GY', 'gdp_growth'));
  assert.notEqual(evidenceId('GY', 'gdp_growth'), evidenceId('TT', 'gdp_growth'));
});

// ── ChartSpec ──────────────────────────────────────────────────────────────────────────────

test('buildChartSpecification returns a complete spec per plan §5', () => {
  const spec = buildChartSpecification([evidence()], intent());
  assert.equal(spec.type, 'line');
  assert.equal(spec.indicator, 'gdp_growth');
  assert.equal(spec.indicatorLabel, 'GDP Growth Rate');
  assert.deepEqual(spec.countries, ['GY']);
  assert.equal(spec.unit, '%');
  assert.ok(spec.title.includes('GDP Growth Rate'));
  assert.deepEqual(spec.evidenceIds, ['GY:gdp_growth']);
});

test('the chart year range reflects points actually retrieved, not the requested window', () => {
  // Asking for 1990–2024 but receiving 2020–2022 must not produce an axis implying 1990 coverage.
  const spec = buildChartSpecification([evidence()], intent({ yearFrom: 1990, yearTo: 2024 }));
  assert.equal(spec.yearFrom, 2020);
  assert.equal(spec.yearTo, 2022);
  assert.ok(spec.title.includes('2020–2022'));
});

test('null-valued years are excluded from the charted range', () => {
  const spec = buildChartSpecification(
    [evidence({ points: [point(2019, null), point(2020, 43.5), point(2021, 20.1)] })],
    intent(),
  );
  assert.equal(spec.yearFrom, 2020, 'a leading gap year must not widen the axis');
});

test('an all-null or empty series yields no chart rather than an empty one', () => {
  assert.equal(buildChartSpecification([], intent()), null);
  assert.equal(
    buildChartSpecification([evidence({ points: [point(2020, null)] })], intent()),
    null,
  );
});

test('buildChartSpecification accepts a multi-country shape for Phase 3a comparison', () => {
  const spec = buildChartSpecification([evidence()], { countries: ['TT', 'GY'] });
  assert.deepEqual(spec.countries, ['TT', 'GY']);
});

// ── Sheet naming / collision safety ────────────────────────────────────────────────────────

test('resolveSheetName returns the base name when nothing collides', () => {
  assert.equal(resolveSheetName('CaribEcon GY', []), 'CaribEcon GY');
  assert.equal(resolveSheetName('CaribEcon GY', ['Sheet1', 'Data']), 'CaribEcon GY');
});

test('resolveSheetName suffixes rather than overwriting an existing sheet', () => {
  assert.equal(resolveSheetName('Report', ['Report']), 'Report (2)');
  assert.equal(resolveSheetName('Report', ['Report', 'Report (2)']), 'Report (3)');
});

test('collision matching is case-insensitive — Excel treats Report and report as one sheet', () => {
  assert.equal(resolveSheetName('Report', ['REPORT']), 'Report (2)');
  assert.equal(resolveSheetName('report', ['Report']), 'report (2)');
});

test('names are truncated to Excel\'s 31-character limit', () => {
  const long = 'CaribEcon Guyana gross government debt as a share of GDP';
  const name = resolveSheetName(long, []);
  assert.ok(name.length <= 31, `got ${name.length} chars`);
});

test('a suffix never pushes the name past 31 characters', () => {
  const long = 'CaribEcon Guyana gross government debt as a share of GDP';
  const first = resolveSheetName(long, []);
  const second = resolveSheetName(long, [first]);
  assert.ok(second.length <= 31, `got ${second.length} chars: "${second}"`);
  assert.notEqual(second.toLowerCase(), first.toLowerCase());
  assert.ok(second.endsWith('(2)'));
});

test('characters Excel rejects in a sheet name are stripped', () => {
  const name = resolveSheetName('GDP/Debt: [2024] *draft?', []);
  assert.doesNotMatch(name, /[[\]*?/\\:]/);
  assert.ok(name.length > 0);
});

test('a name that sanitises to nothing falls back rather than producing an empty sheet name', () => {
  assert.equal(resolveSheetName('///', []), 'Report');
});

// ── WorkbookPlan structure ─────────────────────────────────────────────────────────────────

test('a single-indicator plan has a table, a chart, and a sources section', () => {
  const plan = buildWorkbookPlan([result()], intent());
  assert.equal(plan.sections.filter(s => s.kind === 'table').length, 1);
  assert.equal(plan.sections.filter(s => s.kind === 'sources').length, 1);
  assert.equal(plan.charts.length, 1);
  assert.ok(plan.sheetName.length > 0 && plan.sheetName.length <= 31);
  assert.ok(plan.evidenceSheetName.length > 0 && plan.evidenceSheetName.length <= 31);
  assert.notEqual(plan.sheetName, plan.evidenceSheetName);
});

/* Regression: the report and evidence sheet names were previously built by sanitising
 * `base` and `base + " Evidence"` independently. With three indicators the base already
 * exceeded 31 characters, so both truncated to the SAME string — the evidence sheet would have
 * collided with its own report sheet and lost the "Evidence" label entirely. The single-indicator
 * case passed because the short name left room for the suffix, which is why this needs its own
 * test at maximum selection width. */
test('report and evidence sheet names stay distinct at every selection width', () => {
  for (const indicators of [['gdp_growth'], ['gdp_growth', 'inflation'], ['gdp_growth', 'inflation', 'nominal_gdp']]) {
    const plan = buildWorkbookPlan(
      indicators.map(slug => result(evidence({ indicator: slug }))),
      intent({ indicators }),
    );
    assert.notEqual(
      plan.sheetName.toLowerCase(),
      plan.evidenceSheetName.toLowerCase(),
      `names collide with ${indicators.length} indicator(s)`,
    );
    assert.ok(plan.sheetName.length <= 31 && plan.evidenceSheetName.length <= 31);
    assert.ok(/evidence/i.test(plan.evidenceSheetName), 'the Evidence label must survive truncation');
  }
});

test('the sheet name is stable across indicator selections, distinguished by collision suffix', () => {
  // Two Deep Dives on the same economy should read as "… Deep Dive" and "… Deep Dive (2)",
  // not as two differently-truncated slug lists.
  const one = buildWorkbookPlan([result()], intent({ indicators: ['gdp_growth'] }));
  const three = buildWorkbookPlan(
    [result(), result(evidence({ indicator: 'inflation' })), result(evidence({ indicator: 'unemployment' }))],
    intent({ indicators: ['gdp_growth', 'inflation', 'unemployment'] }),
  );
  assert.equal(one.sheetName, three.sheetName);
  assert.equal(resolveSheetName(three.sheetName, [one.sheetName]), `${one.sheetName} (2)`);
});

test('sections never overlap — every block starts after the previous one ends', () => {
  const plan = buildWorkbookPlan(
    [
      result(),
      result(evidence({ indicator: 'inflation', label: 'Inflation Rate' })),
      result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' })),
    ],
    intent({ indicators: ['gdp_growth', 'inflation', 'nominal_gdp'] }),
  );

  const ordered = [...plan.sections].sort((a, b) => a.startRow - b.startRow);
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    assert.ok(
      ordered[i].startRow >= prev.startRow + prev.rowCount,
      `section at row ${ordered[i].startRow} collides with the block ending at ${prev.startRow + prev.rowCount}`,
    );
  }
  assert.ok(plan.totalRows >= ordered.at(-1).startRow);
});

test('one chart per indicator, never a combined chart across mismatched units', () => {
  const plan = buildWorkbookPlan(
    [result(), result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' }))],
    intent({ indicators: ['gdp_growth', 'nominal_gdp'] }),
  );
  assert.equal(plan.charts.length, 2);
  assert.deepEqual(plan.charts.map(c => c.spec.indicator), ['gdp_growth', 'nominal_gdp']);
  for (const chart of plan.charts) {
    assert.equal(chart.spec.countries.length, 1);
  }
});

test('a chart is anchored clear of its own table columns', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const table = plan.sections.find(s => s.kind === 'table');
  assert.ok(plan.charts[0].column >= table.columnCount, 'chart would sit on top of the table');
});

test('the charted source range covers the header plus every data row', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const table = plan.sections.find(s => s.kind === 'table');
  const chart = plan.charts[0];
  assert.equal(chart.sourceStartRow, table.startRow + table.headerRowOffset);
  assert.equal(chart.sourceRowCount, evidence().points.length + 1);
});

test('a series with no plottable values produces a table but no chart', () => {
  const plan = buildWorkbookPlan(
    [result(evidence({ points: [point(2020, null), point(2021, null)] }))],
    intent(),
  );
  assert.equal(plan.sections.filter(s => s.kind === 'table').length, 1);
  assert.equal(plan.charts.length, 0, 'an all-gap series must not yield an empty chart');
});

// ── Table content ──────────────────────────────────────────────────────────────────────────

test('a gap year occupies a row with a blank cell — never zero, never dropped', () => {
  const withGap = evidence({ points: [point(2020, 43.5), point(2021, null), point(2022, 62.3)] });
  const table = buildWorkbookPlan([result(withGap)], intent()).sections.find(s => s.kind === 'table');
  const dataRows = table.rows.slice(table.firstDataRowOffset, table.firstDataRowOffset + 3);

  assert.equal(dataRows.length, 3, 'the gap year still occupies a row');
  assert.deepEqual(dataRows.map(r => r[0]), [2020, 2021, 2022]);
  assert.equal(dataRows[1][1], null, 'a hub gap must be blank, not 0');
});

test('the offsets the renderer styles by point at the rows they claim to', () => {
  const table = buildWorkbookPlan([result()], intent()).sections.find(s => s.kind === 'table');
  assert.equal(table.rows[table.titleRowOffset][0], 'GDP Growth Rate');
  assert.deepEqual(table.rows[table.headerRowOffset], table.header);
  assert.equal(table.rows[table.firstDataRowOffset][0], 2020);
  for (const offset of table.summaryRowOffsets) {
    assert.equal(table.rows[offset][0], 'Period average');
  }
  assert.equal(table.rowCount, table.rows.length);
});

test('each column of the table has a number format matching its content', () => {
  const rate = buildWorkbookPlan([result()], intent()).sections.find(s => s.kind === 'table');
  assert.equal(rate.dataNumberFormats[0], '0');            // Year
  assert.equal(rate.dataNumberFormats[1], '0.00"%"');      // gdp_growth is "%"
  assert.equal(rate.dataNumberFormats[2], '0.00"pp"');     // a rate's change is in points

  const level = buildWorkbookPlan(
    [result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' }))],
    intent({ indicators: ['nominal_gdp'] }),
  ).sections.find(s => s.kind === 'table');
  assert.equal(level.dataNumberFormats[1], '#,##0.00', 'a level indicator needs thousands separators');
  assert.equal(level.dataNumberFormats[2], '0.00"%"', "a level's change is a relative percentage");
});

test('no number format ends in a bare decimal separator', () => {
  // `#,##0.##` renders a whole number as "1,349,667." — Excel prints the separator literally.
  for (const unit of ['%', 'persons', 'months', 'US$ mn', 'GY$', 'J$ per US$', 'Newly Added Unit']) {
    assert.ok(!/\.#*$/.test(numberFormatForUnit(unit)), `${unit} must not end in a bare separator`);
  }
});

test('each unit class gets the precision its values actually carry', () => {
  assert.equal(numberFormatForUnit('%'), '0.00"%"');
  assert.equal(numberFormatForUnit('persons'), '#,##0');        // population is always whole
  assert.equal(numberFormatForUnit('months'), '#,##0.0');
  assert.equal(numberFormatForUnit('J$ per US$'), '#,##0.0000'); // 116.9698 must survive
  assert.equal(numberFormatForUnit('US$ mn'), '#,##0.00');
  assert.equal(numberFormatForUnit('GY$'), '#,##0');             // per-capita level
  assert.equal(numberFormatForUnit(' % '), '0.00"%"');           // unit strings are trimmed
});

// ── Sources, caveats, gaps ─────────────────────────────────────────────────────────────────

test('every series contributes a summarised sources row, one per indicator, not per observation', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const sourcesSection = plan.sections.find(s => s.kind === 'sources');
  assert.equal(sourcesSection.rows.length, 1, 'one row per indicator, not one per year');

  const row = sourcesSection.rows[0];
  assert.equal(row.indicator, 'GDP Growth Rate');
  assert.equal(row.unit, '%');
  assert.equal(row.coverage, '2020–2022');
  assert.equal(row.source, 'IMF'); // sourceOrg's short tag, not the full citation string
  assert.equal(row.series, 'NGDP_RPCH'); // extracted from the DataMapper URL, incl. the underscore
  assert.equal(row.vintage, '2026-04');
  assert.equal(row.sourceUrl, 'https://www.imf.org/external/datamapper/NGDP_RPCH');

  // Internal-only fields must not appear on the user-facing summary row.
  for (const internal of ['evidenceId', 'confidence', 'sourceTier']) {
    assert.ok(!(internal in row), `sources row leaked internal field "${internal}"`);
  }
});

test('SOURCE_SUMMARY_COLUMNS names a real SourceSummaryRow key for every heading it declares', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const sourcesSection = plan.sections.find(s => s.kind === 'sources');
  const row = sourcesSection.rows[0];
  for (const [key, heading] of SOURCE_SUMMARY_COLUMNS) {
    assert.ok(key in row, `SOURCE_SUMMARY_COLUMNS declares "${key}", which SourceSummaryRow does not carry`);
    assert.ok(heading.length > 0);
  }
  assert.deepEqual(SOURCE_SUMMARY_COLUMNS.map(([, h]) => h), sourcesSection.header);
  assert.equal(sourcesSection.urlColumnIndex, SOURCE_SUMMARY_COLUMNS.findIndex(([k]) => k === 'sourceUrl'));
});

test('a series with no machine-readable identifier reports "—" rather than a fabricated code', () => {
  const primary = evidence({
    source: 'T&T Ministry of Finance — Review of the Economy 2025',
    sourceOrg: 'MoF (T&T)',
    sourceUrl: 'https://www.finance.gov.tt/category/economic-review/',
  });
  const plan = buildWorkbookPlan([result(primary)], intent());
  const row = plan.sections.find(s => s.kind === 'sources').rows[0];
  assert.equal(row.series, '—');
});

test('WorkbookPlan.sources exposes the same rows as structured data, not only rendered output', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const sourcesSection = plan.sections.find(s => s.kind === 'sources');
  assert.deepEqual(plan.sources, sourcesSection.rows);
});

test('the title section names the economy and points to the hidden Evidence sheet', () => {
  const plan = buildWorkbookPlan([result(), result(evidence({ indicator: 'inflation', label: 'Inflation Rate' }))], intent({ indicators: ['gdp_growth', 'inflation'] }));
  const title = plan.sections.find(s => s.kind === 'title');
  assert.ok(title, 'every plan has a title section');
  assert.equal(plan.sections[0], title, 'the title section is always first');
  assert.match(title.title, /GY/);
  assert.match(title.subtitle, /2 indicators/);
  assert.match(title.subtitle, /hidden Evidence sheet/i);
});

test('with no succeeded indicators, the title still reports the empty result honestly', () => {
  const plan = buildWorkbookPlan([], intent());
  const title = plan.sections.find(s => s.kind === 'title');
  assert.match(title.subtitle, /no sourced series/i);
});

test('mixed units across indicators raise a do-not-compare caveat', () => {
  const plan = buildWorkbookPlan(
    [result(), result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' }))],
    intent({ indicators: ['gdp_growth', 'nominal_gdp'] }),
  );
  assert.ok(plan.caveats.some(c => /must not be differenced, summed, or ranked/i.test(c)));
});

test('a single-unit report raises no comparability caveat', () => {
  const plan = buildWorkbookPlan(
    [result(), result(evidence({ indicator: 'inflation', label: 'Inflation Rate' }))],
    intent({ indicators: ['gdp_growth', 'inflation'] }),
  );
  assert.ok(!plan.caveats.some(c => /must not be differenced/i.test(c)));
});

test('a retrieval miss becomes a visible caveat rather than being dropped', () => {
  const misses = [{ kind: 'series', detail: 'The hub has no "fiscal_balance" series for CW.' }];
  const plan = buildWorkbookPlan([result()], intent(), misses);
  assert.ok(plan.caveats.some(c => c.includes('fiscal_balance')));
  assert.ok(plan.sections.some(s => s.kind === 'caveats'));
});

test('a series-level source note is surfaced as a caveat', () => {
  const noted = evidence({ note: 'Primary CBB ratio diverges from the WEO series.' });
  const plan = buildWorkbookPlan([result(noted)], intent());
  assert.ok(plan.caveats.some(c => c.includes('diverges')));
});

test('with nothing to warn about, no caveats section is emitted', () => {
  const plan = buildWorkbookPlan([result()], intent());
  assert.equal(plan.caveats.length, 0);
  assert.ok(!plan.sections.some(s => s.kind === 'caveats'));
});

// ── Evidence sheet lineage ─────────────────────────────────────────────────────────────────

test('the evidence sheet carries one fully-attributed row per retrieved point', () => {
  const plan = buildWorkbookPlan([result()], intent());
  assert.equal(plan.evidenceRows.length, evidence().points.length);

  for (const row of plan.evidenceRows) {
    assert.equal(row.evidenceId, 'GY:gdp_growth');
    for (const key of ['country', 'indicator', 'label', 'unit', 'vintage', 'source', 'sourceOrg', 'sourceTier', 'sourceUrl', 'confidence']) {
      assert.ok(row[key], `evidence row is missing "${key}" — a point without provenance is not traceable`);
    }
    assert.ok(Number.isInteger(row.year));
    assert.ok(row.value === null || typeof row.value === 'number');
    assert.ok(row.type, 'actual/estimate/projection/derived must survive to the evidence sheet');
  }
});

test('the evidence header labels every column the rows actually carry', () => {
  const plan = buildWorkbookPlan([result()], intent());
  // The header must not silently drift from the EvidenceRow shape.
  assert.equal(plan.evidenceHeader.length, Object.keys(plan.evidenceRows[0]).length);
  assert.equal(plan.evidenceHeader.length, EVIDENCE_COLUMNS.length);
});

test('EVIDENCE_COLUMNS names a real EvidenceRow key for every heading it declares', () => {
  // The renderer writes each cell as row[key] in this order, so a key that does not exist on
  // EvidenceRow would silently produce a column of blanks in the workbook.
  const plan = buildWorkbookPlan([result()], intent());
  const row = plan.evidenceRows[0];
  for (const [key, heading] of EVIDENCE_COLUMNS) {
    assert.ok(key in row, `EVIDENCE_COLUMNS declares "${key}", which EvidenceRow does not carry`);
    assert.ok(heading.length > 0);
  }
  assert.deepEqual(EVIDENCE_COLUMNS.map(([, h]) => h), plan.evidenceHeader);
});

test('dataRowCount matches the rows between the header and the summary', () => {
  const table = buildWorkbookPlan([result()], intent()).sections.find(s => s.kind === 'table');
  assert.equal(table.dataRowCount, evidence().points.length);
  // The renderer applies number formats to exactly this band; if it were wrong it would format
  // the blank spacer or the summary row as data.
  const lastDataOffset = table.firstDataRowOffset + table.dataRowCount - 1;
  assert.equal(table.rows[lastDataOffset][0], 2022);
  assert.equal(table.rows[lastDataOffset + 1][0], '', 'the row after the data band must be the spacer');
});

test('a gap point still gets an evidence row, so the gap itself is auditable', () => {
  const withGap = evidence({ points: [point(2020, 43.5), point(2021, null)] });
  const plan = buildWorkbookPlan([result(withGap)], intent());
  assert.equal(plan.evidenceRows.length, 2);
  assert.equal(plan.evidenceRows[1].value, null);
});

// ── Traceability: the anti-fabrication check ───────────────────────────────────────────────

test('every number written to a table traces to a retrieved point or a real calculation', () => {
  const results = [
    result(),
    result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn', points: [point(2020, 100), point(2021, 110), point(2022, 121)] })),
  ];
  const plan = buildWorkbookPlan(results, intent({ indicators: ['gdp_growth', 'nominal_gdp'] }));

  for (const [i, table] of plan.sections.filter(s => s.kind === 'table').entries()) {
    const source = results[i];
    const retrieved = new Map(source.evidence.points.map(p => [p.year, p.value]));
    const change = new Map(source.change.results.map(r => [r.year, r.value]));

    const dataRows = table.rows.slice(
      table.firstDataRowOffset,
      table.firstDataRowOffset + source.evidence.points.length,
    );

    for (const [year, value, delta] of dataRows) {
      assert.ok(retrieved.has(year), `year ${year} appears in the table but was never retrieved`);
      assert.equal(value, retrieved.get(year), `value for ${year} does not match retrieved evidence`);
      assert.equal(delta, change.get(year) ?? null, `change for ${year} was not produced by ${source.change.name}`);
    }

    for (const offset of table.summaryRowOffsets) {
      assert.equal(table.rows[offset][1], source.periodAverage.value);
    }
  }
});

test('every calculated figure names real retrieved years as its inputs', () => {
  const source = result();
  const retrievedYears = new Set(source.evidence.points.map(p => p.year));

  for (const calc of [...source.change.results, source.periodAverage]) {
    for (const year of calc.inputYears) {
      assert.ok(retrievedYears.has(year), `calculation cites year ${year}, which was never retrieved`);
    }
  }
});

test('every chart plots evidence IDs that exist in the plan', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const known = new Set(plan.evidenceRows.map(r => r.evidenceId));
  assert.ok(known.size > 0, 'no evidence rows produced — nothing to check chart IDs against');
  for (const id of known) assertRealEvidenceId(id);

  assert.ok(plan.charts.length > 0, 'no charts produced — nothing to check');
  for (const chart of plan.charts) {
    assert.ok(chart.spec.evidenceIds.length > 0, 'chart declares no evidence IDs');
    for (const id of chart.spec.evidenceIds) {
      assertRealEvidenceId(id);
      assert.ok(known.has(id), `chart references unknown evidence ID ${id}`);
    }
  }
});

// ── Determinism ────────────────────────────────────────────────────────────────────────────

test('deterministic: the same evidence produces an identical plan', () => {
  const build = () => buildWorkbookPlan([result()], intent(), [{ kind: 'years', detail: 'x' }]);
  assert.deepEqual(build(), build());
});

test('the brand series palette is available and valid for chart formatting', () => {
  assert.ok(SERIES_COLORS.length >= 6);
  for (const color of SERIES_COLORS) assert.match(color, /^#[0-9A-F]{6}$/i);
});
