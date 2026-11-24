import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixMatch, isCalendarName, isMeasureTableName, classifyTable, classifyQuery, isParameterCode, isFunctionQuery } from '../src/core/classify.js';
import { parseTmdl } from '../src/core/parser.js';
import { collectQueries } from '../src/core/mquery.js';
import { buildItems } from '../src/core/items.js';
import { fixture } from './helpers.js';

test('prefixMatch: Dim/Fact/fn conventions and case rule', () => {
  const yes = ['DimCustomer', 'dimCustomer', 'Dim_Customer', 'Dim Customer', 'DIM_CUSTOMER', 'DIM CUSTOMER', 'DIMCustomer', 'Dim1', 'Dim'];
  const no = ['Dimonitor', 'Dimension', 'DIMONITOR', 'dimension', 'XDim', ''];
  for (const n of yes) assert.equal(prefixMatch(n, 'dim'), true, n);
  for (const n of no) assert.equal(prefixMatch(n, 'dim'), false, n);
  for (const n of ['FactSales', 'factPPH', 'Fact PBB', 'FACT_REALISASI', 'Fact-X']) assert.equal(prefixMatch(n, 'fact'), true, n);
  for (const n of ['Factory', 'Factor', 'factory', 'FACTORY']) assert.equal(prefixMatch(n, 'fact'), false, n);
  for (const n of ['fnTransform', 'Fn Transform DOT', 'FN_X', 'fxClean', 'FX Rate']) assert.ok(prefixMatch(n, 'fn') || prefixMatch(n, 'fx'), n);
  assert.equal(prefixMatch('Fnord', 'fn'), false);
});

test('calendar and measure-table names', () => {
  for (const n of ['Calendar', 'CalendarTable', 'Calendar Table', 'dimDate', 'DimDate', 'Dim_Date', 'Date', 'Dates', 'DateTable', 'Date Table', 'Kalender', 'Tanggal', 'DateDim', 'LocalDateTable_8c1f6d2a', 'DateTableTemplate_1234', '_Calendar']) {
    assert.equal(isCalendarName(n), true, n);
  }
  for (const n of ['DateOfBirth', 'UpdateLog', 'Dimonitor', 'CalendarEvents']) assert.equal(isCalendarName(n), false, n);
  for (const n of ['Measures Table', 'MeasuresTable', 'Measure Table', '_Measures Table', '_Measures', '#Measures', 'Measures', 'Key Measures', 'KPI Measures', 'tblMeasures']) {
    assert.equal(isMeasureTableName(n), true, n);
  }
  for (const n of ['MeasurementData', 'Measured Values', 'FactSales']) assert.equal(isMeasureTableName(n), false, n);
});

test('classifyTable: special by name / dataCategory / structure, then fact, dim, other', () => {
  assert.equal(classifyTable({ name: 'dimDate' }).group, 'special'); // special wins over dim
  assert.equal(classifyTable({ name: 'Periode', dataCategory: 'Time' }).group, 'special');
  assert.equal(classifyTable({ name: 'KPI', columns: [], measureCount: 4 }).reason, 'tabel measure');
  assert.equal(classifyTable({ name: 'KPI', columns: [{ name: 'Column1', isHidden: false }], measureCount: 4 }).group, 'special');
  assert.equal(classifyTable({ name: 'Sales', columns: [{ name: 'Amount', isHidden: true }, { name: 'Qty', isHidden: true }], measureCount: 5 }).group, 'other');
  assert.equal(classifyTable({ name: 'FactSales', columns: [{ name: 'x' }], measureCount: 1 }).group, 'fact');
  assert.equal(classifyTable({ name: 'DimProvinsi', columns: [{ name: 'x' }] }).group, 'dim');
  assert.equal(classifyTable({ name: 'Dimonitor', columns: [{ name: 'x' }] }).group, 'other');
  assert.equal(classifyTable({ name: 'Glossary', columns: [{ name: 'x' }] }).group, 'other');
});

test('parameter / function detection', () => {
  assert.equal(isParameterCode('"ExampleSite" meta [IsParameterQuery = true, Type = "Text"]'), true);
  assert.equal(isParameterCode('"x" meta [IsParameterQuery=false]'), false);
  assert.equal(isFunctionQuery('Transform', 'Function', ''), true);
  assert.equal(isFunctionQuery('Transform', '', '(x as table) as table => let a = x in a'), true);
  assert.equal(isFunctionQuery('Transform', '', '// c\n(x, y) => x + y'), true);
  assert.equal(isFunctionQuery('Transform', 'Table', 'let Source = 1 in Source'), false);
});

test('fixture 17: tables and Power Query queries land in the expected groups', () => {
  const parsed = parseTmdl(fixture('17-full-model.tmdl'));
  const { tables } = buildItems(parsed);
  const info = (t) => ({
    name: t.name,
    dataCategory: (t.items.find((i) => i.type === 'table') || {}).dataCategory,
    columns: t.items.filter((i) => i.type === 'column'),
    measureCount: t.items.filter((i) => i.type === 'measure').length,
  });
  assert.deepEqual(tables.map((t) => [t.name, classifyTable(info(t)).group]), [
    ['Calendar', 'special'], ['Measures Table', 'special'], ['Last Refresh', 'other'], ['VL06F+MB51', 'other'],
  ]);
  const byTable = new Map(tables.map((t) => [t.key, info(t)]));
  const qs = collectQueries(parsed);
  assert.equal(qs.find((q) => q.name === 'RootFolder').inline.startsWith('"ExampleSite" meta'), true);
  assert.equal(qs.find((q) => q.name === 'Fn Transform DOT').resultType, 'Function');
  assert.equal(qs.find((q) => q.name === 'Mapping_Lintas').queryGroup, 'Dimension Tables');
  assert.deepEqual(qs.map((q) => {
    const c = classifyQuery(q, byTable.get(q.table.toLowerCase()));
    return [q.name, c.group, c.role, c.loaded];
  }), [
    ['Measures Table', 'special', '', true],
    ['Last Refresh', 'other', '', true],
    ['VL06F+MB51', 'other', '', true],
    ['RootFolder', 'fnparam', 'parameter', false],
    ['Mapping_Lintas', 'other', '', false],
    ['Fn Transform DOT', 'fnparam', 'function', false],
  ]);
  assert.equal(classifyQuery({ kind: 'expression', name: 'Staging_MB51', table: '' }).group, 'staging');
  assert.equal(classifyQuery({ kind: 'expression', name: 'KonsinyasiSPBE', table: '', queryGroup: 'Staging\\VL06F' }).group, 'staging');
  assert.equal(classifyQuery({ kind: 'expression', name: 'stg Orders', table: '' }).group, 'staging');
});
