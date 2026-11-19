import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTmdl } from '../src/core/parser.js';
import { buildItems, progress, itemStatus, currentDescription, summarize } from '../src/core/items.js';
import { fixture } from './helpers.js';

test('buildItems groups per table, table item first', () => {
  const { items, tables, byKey } = buildItems(parseTmdl(fixture('17-full-model.tmdl')));
  assert.equal(items.length, 11);
  assert.deepEqual(tables.map((t) => t.name), ['Calendar', 'Measures Table', 'Last Refresh', 'VL06F+MB51']);
  assert.ok(tables.every((t) => t.items[0].type === 'table' && t.editable));
  assert.equal(byKey.get('column|last refresh|timestamp').line, 108);
});

test('partial declarations are merged; editable wins over ref', () => {
  const src = 'createOrReplace\n\n\tref table Sales\n\t\tmeasure A = 1\n\n\t/// d\n\ttable Sales\n\t\tcolumn B\n\t\t\tdataType: int64\n';
  const { items, tables } = buildItems(parseTmdl(src));
  assert.equal(items.length, 3);
  const t = items.find((i) => i.type === 'table');
  assert.equal(t.occurrences, 2);
  assert.equal(t.editable, true);
  assert.equal(t.originalDesc, 'd');
  assert.equal(tables.length, 1);
  assert.equal(tables[0].items[0], t);
});

test('ref-only table group is not editable, children are', () => {
  const { tables } = buildItems(parseTmdl(fixture('08-ref-table.tmdl')));
  assert.equal(tables[0].editable, false);
  assert.equal(tables[0].items[1].editable, true);
});

test('status and progress follow edits', () => {
  const { items } = buildItems(parseTmdl(fixture('02-existing-desc.tmdl')));
  const edits = new Map([['column|sales|customerkey', ''], ['measure|sales|qty', 'Tanpa spasi setelah slash   ']]);
  assert.deepEqual(progress(items, edits), { total: 4, filled: 3, changed: 1 });
  assert.deepEqual(itemStatus(items[1], edits), { filled: false, changed: true });
  assert.deepEqual(itemStatus(items[3], edits), { filled: true, changed: false });
  assert.equal(currentDescription(items[0], edits), 'Tabel fakta penjualan');
});

test('summarize', () => {
  assert.deepEqual(summarize(parseTmdl(fixture('17-full-model.tmdl'))), { table: 4, column: 4, measure: 3, withDesc: 10 });
});
