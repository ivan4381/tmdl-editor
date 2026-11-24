import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTmdl, makeKey } from '../src/core/parser.js';
import { fixture } from './helpers.js';

/** Compact view: [type, table, name, desc, editable?] (Power Query expressions excluded; tested separately) */
function view(r) {
  return r.objects.filter((o) => o.type !== 'expression').map((o) => [o.type, o.table, o.name, o.originalDesc, ...(o.editable ? [] : ['ref'])]);
}

test('01 basic-table', () => {
  const r = parseTmdl(fixture('01-basic-table.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['column', 'Sales', 'OrderDate', ''],
    ['column', 'Sales', 'Amount', ''],
    ['measure', 'Sales', 'Total Sales', ''],
  ]);
  const m = r.objects[3];
  assert.equal(m.key, 'measure|sales|total sales');
  assert.equal(m.declLine, 13);
  assert.equal(m.descStart, 13);
  assert.equal(m.indent, '\t\t');
  assert.equal(m.expression, 'SUM(Sales[Amount])');
  assert.equal(r.objects[1].dataType, 'dateTime');
  assert.equal(r.eol, '\n');
  assert.equal(r.hasBom, false);
  assert.equal(r.trailingNewline, true);
  assert.equal(r.hasCreateOrReplace, true);
  assert.equal(r.hasModel, false);
  assert.deepEqual(r.warnings, []);
});

test('02 existing-desc: single, multi-line with blank, no space after ///', () => {
  const r = parseTmdl(fixture('02-existing-desc.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', 'Tabel fakta penjualan'],
    ['column', 'Sales', 'CustomerKey', 'Kunci pelanggan'],
    ['measure', 'Sales', 'Total Sales', 'Baris pertama\n\nBaris ketiga setelah baris kosong'],
    ['measure', 'Sales', 'Qty', 'Tanpa spasi setelah slash'],
  ]);
  const ts = r.objects[2];
  assert.equal(ts.declLine - ts.descStart, 3);
  assert.equal(r.objects[0].descStart, 2);
});

test('03 quoted-names', () => {
  const r = parseTmdl(fixture('03-quoted-names.tmdl'));
  assert.deepEqual(r.objects.map((o) => o.name), ['Sales Fact', 'Total Sales', "Cust's Name", 'a.b', 'x=y', 'key: value', 'Plain_Name-1&2']);
  assert.ok(r.objects.every((o) => o.table === 'Sales Fact'));
  assert.equal(r.objects[2].key, makeKey('column', 'Sales Fact', "Cust's Name"));
});

test('04 multiline-dax: no fake objects, DAX /// is not a description', () => {
  const r = parseTmdl(fixture('04-multiline-dax.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['measure', 'Sales', 'Sales YTD', ''],
    ['measure', 'Sales', 'Second', ''],
    ['measure', 'Sales', 'Third', ''],
    ['measure', 'Sales', 'Fourth', ''],
  ]);
  assert.match(r.objects[1].expression, /^\/\/\/ komentar DAX/);
  assert.match(r.objects[1].expression, /RETURN TOTALYTD/);
});

test('05 backtick-expr: fence content is opaque, even when shallower', () => {
  const r = parseTmdl(fixture('05-backtick-expr.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['measure', 'Sales', 'Fenced', ''],
    ['measure', 'Sales', 'After', 'deskripsi asli'],
    ['table', 'Second', 'Second', ''],
    ['column', 'Second', 'RealCol', ''],
  ]);
  assert.equal(r.objects.find((o) => o.name === 'RealCol').dataType, 'string');
  assert.match(r.objects[1].expression, /table FakeShallow/);
  assert.deepEqual(r.warnings, []);
  // The fenced expression is recognised as a (non-container) object; its fake table stays opaque.
  assert.deepEqual(r.objects.filter((o) => o.type === 'expression').map((o) => o.name), ['Fn X']);
  assert.deepEqual(r.mQueries.map((q) => [q.name, q.fenced, q.bodyStart + 1, q.bodyEnd + 1]), [['Fn X', true, 19, 20]]);
});

test('06 partition-m: no fake objects from M', () => {
  const r = parseTmdl(fixture('06-partition-m.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Customers', 'Customers', ''],
    ['column', 'Customers', 'Name', ''],
  ]);
});

test('07 multi-table, hierarchy and relationship ignored', () => {
  const r = parseTmdl(fixture('07-multi-table.tmdl'));
  assert.deepEqual(r.objects.map((o) => o.key), [
    'table|date|date', 'column|date|date', 'column|date|year',
    'table|sales|sales', 'column|sales|amount', 'measure|sales|total',
    'table|product|product', 'column|product|name',
  ]);
  assert.equal(r.objects[0].originalDesc, 'Dimensi tanggal');
});

test('08 ref-table: table non-editable, child editable', () => {
  const r = parseTmdl(fixture('08-ref-table.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', '', 'ref'],
    ['measure', 'Sales', 'Total Sales', ''],
  ]);
});

test('09 no-wrapper (PBIP file at depth 0)', () => {
  const r = parseTmdl(fixture('09-no-wrapper.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Product', 'Product', 'Dimensi produk'],
    ['column', 'Product', 'ProductKey', ''],
    ['column', 'Product', 'Product Name', ''],
    ['measure', 'Product', '# Products', ''],
  ]);
  assert.equal(r.objects[0].indent, '');
  assert.equal(r.objects[1].isHidden, true);
  assert.equal(r.objects[2].isHidden, false);
  assert.equal(r.trailingNewline, false);
  assert.equal(r.hasCreateOrReplace, false);
});

test('10 crlf-bom detected', () => {
  const r = parseTmdl(fixture('10-crlf-bom.tmdl'));
  assert.equal(r.eol, '\r\n');
  assert.equal(r.hasBom, true);
  assert.equal(r.trailingNewline, true);
  assert.equal(r.objects.length, 4);
  assert.ok(r.lines.every((l) => !l.includes('\r')));
});

test('11 spaces-indent: exact prefix captured', () => {
  const r = parseTmdl(fixture('11-spaces-indent.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', 'Tabel dengan indentasi dua spasi'],
    ['column', 'Sales', 'Amount', ''],
    ['measure', 'Sales', 'Total', ''],
  ]);
  assert.equal(r.objects[0].indent, '  ');
  assert.equal(r.objects[2].indent, '    ');
  assert.equal(r.objects[2].expression, 'SUM(Sales[Amount])');
});

test('12 blank-line-gap breaks description', () => {
  const r = parseTmdl(fixture('12-blank-line-gap.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['measure', 'Sales', 'A', ''],
    ['measure', 'Sales', 'B', 'ini deskripsi B'],
  ]);
  assert.equal(r.objects[0].descStart, r.objects[0].declLine);
});

test('13 calc-column expression captured', () => {
  const r = parseTmdl(fixture('13-calc-column.tmdl'));
  assert.equal(r.objects.length, 3);
  assert.equal(r.objects[1].expression, 'VAR c = Sales[Cost]\nRETURN Sales[Amount] - c');
  assert.equal(r.objects[1].dataType, 'decimal');
  assert.equal(r.objects[2].expression, 'Sales[Amount] * 2');
  assert.equal(r.objects[2].isHidden, false);
});

test('14 unicode description', () => {
  const r = parseTmdl(fixture('14-unicode-desc.tmdl'));
  assert.equal(r.objects[0].originalDesc, 'Penjualan 🚀 "harian" — tahun berjalan');
});

test('15 idempotent fixture parses (trailing spaces kept in originalDesc)', () => {
  const r = parseTmdl(fixture('15-idempotent.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', 'deskripsi dengan spasi di akhir   '],
    ['measure', 'Sales', 'X', ''],
    ['column', 'Sales', 'C', '\nisi'],
  ]);
  assert.equal(r.trailingNewline, false);
});

test('16 case-insensitive keywords', () => {
  const r = parseTmdl(fixture('16-case-insensitive.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['measure', 'Sales', 'X', ''],
    ['column', 'Sales', 'Y', ''],
    ['table', 'Other', 'Other', '', 'ref'],
    ['measure', 'Other', 'Z', ''],
  ]);
  assert.equal(r.objects[2].isHidden, true);
  assert.equal(r.objects[2].dataType, 'int64');
});

test('17 full-model matches plan §9 expected parse', () => {
  const r = parseTmdl(fixture('17-full-model.tmdl'));
  const got = r.objects.filter((o) => o.type !== 'expression').map((o) => [o.type, o.table, o.name, o.originalDesc !== '']);
  assert.deepEqual(got, [
    ['table', 'Calendar', 'Calendar', true],
    ['column', 'Calendar', 'Date', true],
    ['column', 'Calendar', 'Month', true],
    ['table', 'Measures Table', 'Measures Table', true],
    ['measure', 'Measures Table', 'OT Terminal Not Adjusted', true],
    ['measure', 'Measures Table', 'Label status pengisian realisasi', true],
    ['measure', 'Measures Table', 'SPBE Performance Indicator', true],
    ['table', 'Last Refresh', 'Last Refresh', true],
    ['column', 'Last Refresh', 'Timestamp', false],
    ['table', 'VL06F+MB51', 'VL06F+MB51', true],
    ['column', 'VL06F+MB51', 'FlagSupplySPBE', true],
  ]);
  assert.equal(r.eol, '\r\n');
  assert.equal(r.hasBom, false);
  assert.equal(r.hasModel, true);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.objects[7].isHidden, true);
  assert.equal(r.objects[8].dataType, 'dateTime');
  assert.equal(r.objects[0].indent, '\t\t');
  assert.equal(r.objects[1].indent, '\t\t\t');
  assert.match(r.objects[5].expression, /^VAR _Now = NOW\(\)/);
  assert.match(r.objects[10].expression, /RETURN FORMAT\(_IsSupplySPBE/);
  // Shared expressions are objects too (query descriptions), after the tables.
  const ex = r.objects.filter((o) => o.type === 'expression');
  assert.deepEqual(ex.map((o) => [o.key, o.originalDesc !== '', o.indent]), [
    ['expression||rootfolder', true, '\t\t'],
    ['expression||mapping_lintas', false, '\t\t'],
    ['expression||fn transform dot', false, '\t\t'],
  ]);
  assert.equal(ex[0].originalDesc, 'Folder Sharepoint VL06F & MB51 (untuk development & production)');
  // M code locations: 3 m partitions + 3 expressions (RootFolder is inline, no body lines).
  assert.deepEqual(r.mQueries.map((q) => [q.kind, q.name, q.descKey, q.bodyStart + 1, q.bodyEnd + 1, q.fenced]), [
    ['partition', 'Measures Table', 'table|measures table|measures table', 97, 101, false],
    ['partition', 'Last Refresh', 'table|last refresh|last refresh', 120, 128, false],
    ['partition', 'VL06F+MB51', 'table|vl06f+mb51|vl06f+mb51', 162, 175, false],
    ['expression', 'RootFolder', 'expression||rootfolder', 0, 0, false],
    ['expression', 'Mapping_Lintas', 'expression||mapping_lintas', 200, 210, false],
    ['expression', 'Fn Transform DOT', 'expression||fn transform dot', 219, 276, true],
  ]);
});

test('19 perspective names are not tables/columns', () => {
  const r = parseTmdl(fixture('19-perspective-names.tmdl'));
  assert.deepEqual(view(r), [
    ['table', 'Sales', 'Sales', ''],
    ['column', 'Sales', 'Amount', ''],
  ]);
});

test('duplicate keys (partial declaration) produce a warning', () => {
  const src = 'createOrReplace\n\n\tref table Sales\n\t\tmeasure A = 1\n\n\ttable Sales\n\t\tcolumn B\n';
  const r = parseTmdl(src);
  assert.equal(r.objects.length, 4);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0].message, /lebih dari sekali/);
});

test('unclosed fence produces a warning', () => {
  const r = parseTmdl('table T\n\tmeasure M = ```\n\t\t1\n');
  assert.equal(r.objects.length, 2);
  assert.ok(r.warnings.some((w) => /tidak pernah ditutup/.test(w.message)));
});

test('a description containing ``` does not open a fence', () => {
  const r = parseTmdl('table T\n\t/// x = ```\n\tcolumn A\n\tcolumn B\n');
  assert.deepEqual(r.objects.map((o) => o.name), ['T', 'A', 'B']);
  assert.equal(r.objects[1].originalDesc, 'x = ```');
});

test('empty input', () => {
  const r = parseTmdl('');
  assert.equal(r.objects.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('database > model > table nesting', () => {
  const r = parseTmdl('createOrReplace\n\tdatabase DB\n\t\tcompatibilityLevel: 1600\n\t\tmodel Model\n\t\t\t/// d\n\t\t\ttable T\n\t\t\t\tcolumn C\n');
  assert.deepEqual(view(r), [['table', 'T', 'T', 'd'], ['column', 'T', 'C', '']]);
});
