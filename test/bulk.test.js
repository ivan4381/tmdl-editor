import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTemplate, replaceAllLiteral } from '../src/core/bulk.js';

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
