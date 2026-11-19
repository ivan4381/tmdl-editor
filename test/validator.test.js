import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoundTrip, skeleton } from '../src/core/validator.js';
import { parseTmdl } from '../src/core/parser.js';
import { fixture } from './helpers.js';

const full = fixture('17-full-model.tmdl');
const replaceOnce = (s, a, b) => {
  assert.ok(s.includes(a), 'pattern not found: ' + a);
  return s.replace(a, b);
};

test('identical text passes', () => {
  assert.deepEqual(validateRoundTrip(full, full), { ok: true, errors: [] });
});

test('skeleton excludes only recognised description lines', () => {
  const p = parseTmdl(full);
  const sk = skeleton(p);
  const descLines = p.objects.reduce((n, o) => n + (o.declLine - o.descStart), 0);
  assert.equal(sk.length, p.lines.length - descLines);
  assert.ok(sk.some((l) => l.text.includes('/// Folder Sharepoint'))); // expression desc stays in skeleton
});

test('changing a DAX line fails', () => {
  const bad = replaceOnce(full, 'SUM ( Fact_OT_SPBE[DOT (MT)] )', 'SUM ( Fact_OT_SPBE[DOT] )');
  const v = validateRoundTrip(full, bad);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].line, 49);
  assert.match(v.errors[0].expected, /DOT \(MT\)/);
});

test('whitespace-only change outside descriptions fails', () => {
  const bad = replaceOnce(full, '\t\t\t\tdisplayFolder: Key Metrics', '    \t\t\tdisplayFolder: Key Metrics');
  assert.equal(validateRoundTrip(full, bad).ok, false);
});

test('EOL change fails', () => {
  const v = validateRoundTrip(full, full.replace(/\r\n/g, '\n'));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Line ending/.test(e.message)));
});

test('BOM change fails', () => {
  const v = validateRoundTrip(full, '﻿' + full);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /BOM/.test(e.message)));
});

test('trailing newline change fails', () => {
  const v = validateRoundTrip(full, full.replace(/(\r\n)+$/, ''));
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /Newline/.test(e.message)));
});

test('adding a description to an expression (out of scope) fails', () => {
  const bad = replaceOnce(full, '\t\texpression Mapping_Lintas =', '\t\t/// baru\r\n\t\texpression Mapping_Lintas =');
  assert.equal(validateRoundTrip(full, bad).ok, false);
});

test('changing a queryGroup description fails', () => {
  const bad = replaceOnce(full, '/// Custom Functions untuk Transformasi & Parameters', '/// diubah');
  assert.equal(validateRoundTrip(full, bad).ok, false);
});

test('a /// line injected into DAX fails', () => {
  // Unfenced multi-line DAX of 'OT Terminal Not Adjusted' (indent: 5 tabs).
  const bad = replaceOnce(full, '\t\t\t\t\tSUM ( Fact_OT_SPBE', '\t\t\t\t\t/// x\r\n\t\t\t\t\tSUM ( Fact_OT_SPBE');
  assert.equal(validateRoundTrip(full, bad).ok, false);
});

test('renaming an object fails', () => {
  const bad = replaceOnce(full, '\t\t\tcolumn Month', '\t\t\tcolumn Bulan');
  const v = validateRoundTrip(full, bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /identitas objek/.test(e.message)));
});

test('removing an object fails', () => {
  const bad = replaceOnce(full, '\t\t\tcolumn Timestamp\r\n', '');
  assert.equal(validateRoundTrip(full, bad).ok, false);
});

test('description change on a ref table fails', () => {
  const src = 'createOrReplace\n\n\t/// a\n\tref table Sales\n\t\tmeasure M = 1\n';
  const bad = src.replace('/// a', '/// b');
  const v = validateRoundTrip(src, bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /non-editable/.test(e.message)));
});

test('stray CR inside a description line fails (LF file)', () => {
  const src = 'table T\n\t/// a\n\tcolumn C\n';
  const v = validateRoundTrip(src, 'table T\n\t/// a\rb\n\tcolumn C\n');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /CR\/LF/.test(e.message)));
});

test('description-only changes pass', () => {
  const ok = replaceOnce(full, '/// Date Table (Kalender)', '/// Kalender\r\n\t\t///\r\n\t\t/// baris 3');
  assert.equal(validateRoundTrip(full, ok).ok, true);
});
