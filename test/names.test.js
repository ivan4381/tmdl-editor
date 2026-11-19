import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObjectName, quoteName, NAME_SRC } from '../src/core/names.js';

test('parseObjectName unquotes and unescapes', () => {
  assert.equal(parseObjectName("'Total Sales'"), 'Total Sales');
  assert.equal(parseObjectName("'Cust''s Name'"), "Cust's Name");
  assert.equal(parseObjectName("'a.b'"), 'a.b');
  assert.equal(parseObjectName('VL06F+MB51'), 'VL06F+MB51');
  assert.equal(parseObjectName('Staging\\VL06F'), 'Staging\\VL06F');
});

test('quoteName quotes only when required', () => {
  assert.equal(quoteName('Sales'), 'Sales');
  assert.equal(quoteName('VL06F+MB51'), 'VL06F+MB51');
  assert.equal(quoteName('Total Sales'), "'Total Sales'");
  assert.equal(quoteName("Cust's"), "'Cust''s'");
  assert.equal(quoteName('a.b'), "'a.b'");
  assert.equal(quoteName('x=y'), "'x=y'");
  assert.equal(quoteName('k:v'), "'k:v'");
});

test('quote/parse round trip', () => {
  for (const n of ['Sales', 'Total Sales', "it''s", "'", 'a.b=c:d', 'Ünïcødé 🚀']) {
    assert.equal(parseObjectName(quoteName(n)), n);
  }
});

test('NAME_SRC matches the whole token', () => {
  const re = new RegExp('^(?:' + NAME_SRC + ')$');
  for (const t of ["'Total Sales'", "'Cust''s Name'", 'VL06F+MB51', 'Staging\\VL06F', 'a&b-c']) assert.ok(re.test(t), t);
  for (const t of ['a b', 'a.b', "'unterminated"]) assert.ok(!re.test(t), t);
});
