import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitText, joinText, detectEol, measureIndent, indentDepth, leadingWhitespace, hashText, truncate } from '../src/core/text.js';

test('detectEol', () => {
  assert.equal(detectEol('a\r\nb'), '\r\n');
  assert.equal(detectEol('a\nb'), '\n');
  assert.equal(detectEol('a'), '\n');
});

test('split/join round trip keeps BOM, EOL and trailing newline', () => {
  for (const s of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '﻿x\r\n\r\n', '\n', '\n\n', 'a\n\n']) {
    const r = splitText(s);
    assert.equal(joinText(r.lines, r), s, JSON.stringify(s));
  }
  const r = splitText('﻿a\r\nb\r\n');
  assert.deepEqual(r.lines, ['a', 'b']);
  assert.equal(r.hasBom, true);
  assert.equal(r.trailingNewline, true);
  assert.equal(r.mixedEol, false);
});

test('mixed EOL is flagged', () => {
  assert.equal(splitText('a\r\nb\nc').mixedEol, true);
  assert.equal(splitText('a\nb\rc').mixedEol, true);
});

test('measureIndent and indentDepth', () => {
  assert.deepEqual(measureIndent(['x', '', '\ty']), { kind: 'tab', width: 1 });
  assert.deepEqual(measureIndent(['x', '   ', '  y']), { kind: 'space', width: 2 });
  assert.equal(indentDepth('\t\t', { kind: 'tab', width: 1 }), 2);
  assert.equal(indentDepth('      ', { kind: 'space', width: 2 }), 3);
  assert.equal(indentDepth('\t    ', { kind: 'tab', width: 1 }), 2);
  assert.equal(leadingWhitespace('\t \tx '), '\t \t');
});

test('hashText is stable and discriminating', () => {
  assert.equal(hashText('abc'), hashText('abc'));
  assert.notEqual(hashText('abc'), hashText('abd'));
});

test('truncate', () => {
  assert.equal(truncate('abc', 5), 'abc');
  assert.match(truncate('abcdef', 3), /^abc… \(\+3 karakter\)$/);
});
