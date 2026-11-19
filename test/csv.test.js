import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv, parseCsv, detectDelimiter, matchCsv, CSV_COLUMNS } from '../src/core/csv.js';
import { applyTemplate, replaceAllLiteral } from '../src/core/bulk.js';

const rows = [
  { table: 'Sales', type: 'table', name: 'Sales', dataType: '', isHidden: false, expression: '', description: 'Fakta; penjualan' },
  { table: 'Sales', type: 'measure', name: 'Total Sales', expression: 'SUM(Sales[Amount])', description: 'Baris 1\nBaris "2"' },
  { table: 'Sales', type: 'column', name: 'Amount', dataType: 'decimal', isHidden: true, description: '' },
];

test('toCsv: BOM, header, CRLF, quoting with ;', () => {
  const csv = toCsv(rows);
  assert.ok(csv.startsWith('﻿' + CSV_COLUMNS.join(';') + '\r\n'));
  assert.ok(csv.includes('"Fakta; penjualan"'));
  assert.ok(csv.includes('"Baris 1\nBaris ""2"""'));
  assert.ok(csv.includes('Sales;column;Amount;decimal;TRUE;;\r\n'));
});

test('toCsv with , delimiter and no BOM', () => {
  const csv = toCsv(rows, { delimiter: ',', bom: false });
  assert.ok(csv.startsWith('Table,Type,Name'));
  assert.ok(csv.includes('Fakta; penjualan'));
  assert.ok(!csv.includes('"Fakta; penjualan"'));
});

test('parseCsv round trip for ; and ,', () => {
  for (const delimiter of [';', ',']) {
    const parsed = parseCsv(toCsv(rows, { delimiter }));
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.rows[0], CSV_COLUMNS);
    assert.equal(parsed.rows.length, 4);
    assert.equal(parsed.rows[1][6], 'Fakta; penjualan');
    assert.equal(parsed.rows[2][6], 'Baris 1\nBaris "2"');
  }
});

test('parseCsv handles CRLF inside quotes, LF line endings, empty lines, missing final newline', () => {
  const r = parseCsv('a,b\n"x\r\ny",2\n\n3,"4"');
  assert.deepEqual(r.rows, [['a', 'b'], ['x\r\ny', '2'], ['3', '4']]);
});

test('detectDelimiter ignores delimiters inside quotes', () => {
  assert.equal(detectDelimiter('"a,b,c";d\n'), ';');
  assert.equal(detectDelimiter('a,b,c\n'), ',');
  assert.equal(detectDelimiter('a\tb\tc\n'), '\t');
});

test('matchCsv: matched / changed / not found / read-only', () => {
  const items = [
    { key: 'table|sales|sales', type: 'table', table: 'Sales', name: 'Sales', editable: true },
    { key: 'measure|sales|total sales', type: 'measure', table: 'Sales', name: 'Total Sales', editable: true },
    { key: 'column|sales|amount', type: 'column', table: 'Sales', name: 'Amount', editable: true },
    { key: 'table|ref|ref', type: 'table', table: 'Ref', name: 'Ref', editable: false },
  ];
  const current = { 'table|sales|sales': 'Fakta; penjualan', 'measure|sales|total sales': 'lama', 'column|sales|amount': '' };
  const csv = toCsv([
    ...rows,
    { table: 'Nope', type: 'column', name: 'X', description: 'y' },
    { table: 'Ref', type: 'table', name: 'Ref', description: 'z' },
  ]).replace('Sales;measure;Total Sales', 'SALES;Measure;total sales');
  const m = matchCsv(csv, items, (k) => current[k] ?? '');
  assert.deepEqual(m.errors, []);
  assert.equal(m.matched, 3);
  assert.equal(m.readOnly, 1);
  assert.deepEqual(m.notFound.map((n) => n.name), ['X']);
  assert.deepEqual(m.changed.map((c) => [c.key, c.to]), [['measure|sales|total sales', 'Baris 1\nBaris "2"']]);
});

test('matchCsv reports missing columns', () => {
  const m = matchCsv('Table;Name\nA;B\n', [], () => '');
  assert.equal(m.errors.length, 1);
  assert.match(m.errors[0], /Type, Description/);
});

test('applyTemplate', () => {
  const it = { name: 'Amount', table: 'Sales', type: 'column' };
  assert.equal(applyTemplate('{Name} di {table} ({type}) {other}', it), 'Amount di Sales (kolom) {other}');
});

test('replaceAllLiteral', () => {
  assert.deepEqual(replaceAllLiteral('a.b A.B', 'a.b', 'x', false), { text: 'x x', count: 2 });
  assert.deepEqual(replaceAllLiteral('a.b A.B', 'a.b', 'x', true), { text: 'x A.B', count: 1 });
  assert.deepEqual(replaceAllLiteral('$1', '$1', '$&', true), { text: '$&', count: 1 });
  assert.deepEqual(replaceAllLiteral('abc', '', 'x', true), { text: 'abc', count: 0 });
});
