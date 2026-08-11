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
  SERIES_COLORS,
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

const intent = (over = {}) => ({
  workflow: 'single_country',
  country: 'GY',
  indicators: ['gdp_growth'],
  yearFrom: null,
  yearTo: null,
  outputs: { table: true, charts: true, explanation: false },
  ...over,
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
  const rate = buildWorkbookPlan([result()], intent()).sections[0];
  assert.equal(rate.header[2], 'Change (pp)');

  const level = buildWorkbookPlan(
    [result(evidence({ indicator: 'nominal_gdp', label: 'Nominal GDP', unit: 'GY$ mn' }))],
    intent({ indicators: ['nominal_gdp'] }),
  ).sections[0];
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
  const table = buildWorkbookPlan([result(withGap)], intent()).sections[0];
  const dataRows = table.rows.slice(table.firstDataRowOffset, table.firstDataRowOffset + 3);

  assert.equal(dataRows.length, 3, 'the gap year still occupies a row');
  assert.deepEqual(dataRows.map(r => r[0]), [2020, 2021, 2022]);
  assert.equal(dataRows[1][1], null, 'a hub gap must be blank, not 0');
});

test('the offsets the renderer styles by point at the rows they claim to', () => {
  const table = buildWorkbookPlan([result()], intent()).sections[0];
  assert.equal(table.rows[table.titleRowOffset][0], 'GDP Growth Rate');
  assert.deepEqual(table.rows[table.headerRowOffset], table.header);
  assert.equal(table.rows[table.firstDataRowOffset][0], 2020);
  for (const offset of table.summaryRowOffsets) {
    assert.equal(table.rows[offset][0], 'Period average');
  }
  assert.equal(table.rowCount, table.rows.length);
});

// ── Sources, caveats, gaps ─────────────────────────────────────────────────────────────────

test('every series contributes a sources row carrying its full citation', () => {
  const plan = buildWorkbookPlan([result()], intent());
  const sources = plan.sections.find(s => s.kind === 'sources');
  assert.equal(sources.rows.length, 1);
  const row = sources.rows[0].join(' | ');
  for (const field of ['IMF WEO April 2026', 'IMF', 'comparable', '2026-04', 'high', 'https://']) {
    assert.ok(row.includes(field), `sources row is missing ${field}`);
  }
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
  // 15 keys per EvidenceRow; the header must not silently drift from them.
  assert.equal(plan.evidenceHeader.length, Object.keys(plan.evidenceRows[0]).length);
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
  for (const chart of plan.charts) {
    for (const id of chart.spec.evidenceIds) {
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
