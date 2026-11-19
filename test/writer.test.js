import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { parseTmdl, makeKey } from '../src/core/parser.js';
import { applyDescriptions, normalizeDescription, descriptionLines, isChanged } from '../src/core/writer.js';
import { validateRoundTrip } from '../src/core/validator.js';
import { fixture } from './helpers.js';
import { generateLargeModel } from './gen-full-model-large.mjs';

const T = (table, desc) => [makeKey('table', table, table), desc];
const C = (table, name, desc) => [makeKey('column', table, name), desc];
const M = (table, name, desc) => [makeKey('measure', table, name), desc];

/** Apply edits to a fixture, compare with its .expected file and run the validator. */
function check(name, edits) {
  const input = fixture(name + '.tmdl');
  const parsed = parseTmdl(input);
  const map = new Map(edits);
  for (const k of map.keys()) assert.ok(parsed.objects.some((o) => o.key === k), 'unknown key ' + k);
  const out = applyDescriptions(parsed, map);
  assert.equal(out, fixture(name + '.expected.tmdl'));
  const v = validateRoundTrip(input, out);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  // Re-parse: editable objects carry the normalised new description.
  const again = parseTmdl(out);
  for (const o of again.objects) {
    if (o.editable && map.has(o.key)) assert.equal(o.originalDesc, normalizeDescription(map.get(o.key)), o.key);
  }
  return { input, out, again };
}

test('normalizeDescription', () => {
  assert.equal(normalizeDescription('  a  \r\n\r\nb\t\r\n\n'), '  a\n\nb');
  assert.equal(normalizeDescription('\n\n'), '');
  assert.equal(normalizeDescription(undefined), '');
  assert.equal(normalizeDescription('a\rb'), 'a\nb');
});

test('descriptionLines', () => {
  assert.deepEqual(descriptionLines('\t', 'a\n\nb'), ['\t/// a', '\t///', '\t/// b']);
  assert.deepEqual(descriptionLines('  ', ''), []);
});

test('isChanged ignores trailing whitespace differences', () => {
  assert.equal(isChanged({ originalDesc: 'abc   ' }, 'abc'), false);
  assert.equal(isChanged({ originalDesc: 'abc' }, 'abd'), true);
});

test('01 basic-table: add descriptions to everything', () => {
  check('01-basic-table', [
    T('Sales', 'Tabel fakta penjualan harian'),
    C('Sales', 'OrderDate', 'Tanggal order'),
    C('Sales', 'Amount', 'Nilai transaksi'),
    M('Sales', 'Total Sales', 'Total nilai penjualan'),
  ]);
});

test('02 existing-desc: change, remove, single-line, multi-line', () => {
  check('02-existing-desc', [
    T('Sales', 'Tabel fakta penjualan (diubah)'),
    C('Sales', 'CustomerKey', ''),
    M('Sales', 'Total Sales', 'Satu baris saja'),
    M('Sales', 'Qty', 'Baris satu\r\n\r\nBaris tiga\n  terindentasi   \n\n'),
  ]);
});

test('03 quoted-names', () => {
  check('03-quoted-names', [
    T('Sales Fact', "Tabel 'fakta'"),
    C('Sales Fact', "Cust's Name", 'Nama pelanggan'),
    C('Sales Fact', 'a.b', 'Titik'),
    C('Sales Fact', 'x=y', 'Sama dengan'),
    C('Sales Fact', 'Plain_Name-1&2', 'Tanpa kutip'),
  ]);
});

test('04 multiline-dax: insert next to DAX /// comments', () => {
  check('04-multiline-dax', [
    M('Sales', 'Second', 'Desc second'),
    M('Sales', 'Third', 'Desc third'),
    M('Sales', 'Fourth', 'Desc fourth'),
  ]);
});

test('05 backtick-expr', () => {
  check('05-backtick-expr', [
    M('Sales', 'Fenced', 'Fenced desc'),
    M('Sales', 'After', 'deskripsi baru\ndua baris'),
    C('Second', 'RealCol', 'Kolom'),
  ]);
});

test('08 ref-table: edit to ref table is ignored, measure is written', () => {
  check('08-ref-table', [T('Sales', 'tidak boleh ditulis'), M('Sales', 'Total Sales', 'Total')]);
});

test('10 crlf-bom preserved exactly', () => {
  const { out } = check('10-crlf-bom', [
    T('Sales', 'Tabel fakta penjualan harian'),
    C('Sales', 'OrderDate', 'Tanggal order'),
    C('Sales', 'Amount', 'Nilai transaksi'),
    M('Sales', 'Total Sales', 'Total nilai penjualan'),
  ]);
  assert.ok(out.startsWith('﻿'));
  assert.ok(!/[^\r]\n/.test(out));
});

test('11 spaces-indent: prefix copied exactly', () => {
  check('11-spaces-indent', [T('Sales', 'Diubah'), M('Sales', 'Total', 'Total\nbaris dua')]);
});

test('12 blank-line-gap: new description goes right above the declaration', () => {
  check('12-blank-line-gap', [T('Sales', 'Desc Sales'), M('Sales', 'A', 'Desc A')]);
});

test('13 calc-column', () => {
  check('13-calc-column', [C('Sales', 'Margin', 'Margin kotor')]);
});

test('14 unicode, quotes, /// and ``` inside descriptions', () => {
  const { again } = check('14-unicode-desc', [
    T('Penjualan', ''),
    C('Penjualan', 'Nilai', 'Nilai "rupiah" 💰 = ```\n/// bukan komentar\n\'kutip\'\' dan ``` lagi'),
    M('Penjualan', 'Rata-rata', 'Rata-rata harian ✓ — ditulis "apa adanya"'),
  ]);
  assert.equal(again.objects.length, 3);
});

test('16 case-insensitive', () => {
  check('16-case-insensitive', [C('Sales', 'Y', 'kolom y'), M('Other', 'Z', 'z')]);
});

test('17 full-model: change, add multi-line, remove; expression/queryGroup /// untouched', () => {
  const { out } = check('17-full-model', [
    T('Calendar', 'Tabel kalender (diubah)'),
    C('Last Refresh', 'Timestamp', 'Waktu refresh terakhir\n\nZona WIB'),
    M('Measures Table', 'Label status pengisian realisasi', ''),
    C('VL06F+MB51', 'FlagSupplySPBE', 'Flag supply SPBE'),
  ]);
  assert.ok(out.includes('\t\t/// Folder Sharepoint VL06F & MB51 (untuk development & production)\r\n\t\texpression RootFolder'));
  assert.ok(out.includes("\t\t/// Custom Functions untuk Transformasi & Parameters\r\n\t\tqueryGroup 'Functions & Parameters'"));
});

test('15 idempotent: every fixture round-trips byte for byte with no edits and with unchanged edits', () => {
  const names = readdirSync(new URL('./fixtures/', import.meta.url)).filter((n) => n.endsWith('.tmdl') && !n.includes('.expected.'));
  assert.ok(names.includes('15-idempotent.tmdl'));
  for (const n of names) {
    const input = fixture(n);
    const parsed = parseTmdl(input);
    assert.equal(applyDescriptions(parsed, new Map()), input, n + ' (no edits)');
    const same = new Map(parsed.objects.map((o) => [o.key, o.originalDesc]));
    assert.equal(applyDescriptions(parsed, same), input, n + ' (same edits)');
    assert.ok(validateRoundTrip(input, input).ok, n);
  }
});

test('duplicate keys: every editable occurrence is updated', () => {
  const src = 'createOrReplace\n\n\ttable Sales\n\t\tcolumn A\n\n\ttable Sales\n\t\tmeasure M = 1\n';
  const out = applyDescriptions(parseTmdl(src), new Map([T('Sales', 'x')]));
  assert.equal(out, 'createOrReplace\n\n\t/// x\n\ttable Sales\n\t\tcolumn A\n\n\t/// x\n\ttable Sales\n\t\tmeasure M = 1\n');
  assert.ok(validateRoundTrip(src, out).ok);
});

test('18 full-model-large: parse + write under 1 second', () => {
  const big = generateLargeModel();
  const t0 = performance.now();
  const parsed = parseTmdl(big);
  const edits = new Map();
  for (const o of parsed.objects) if (o.type === 'column' && o.originalDesc === '') edits.set(o.key, 'Deskripsi ' + o.name);
  const out = applyDescriptions(parsed, edits);
  const elapsed = performance.now() - t0;
  assert.equal(parsed.objects.filter((o) => o.type === 'table').length, 200);
  assert.equal(parsed.objects.filter((o) => o.type === 'column').length, 5000);
  assert.equal(parsed.objects.filter((o) => o.type === 'measure').length, 1000);
  assert.ok(elapsed < 1000, 'parse+write took ' + elapsed.toFixed(0) + ' ms');
  const v = validateRoundTrip(big, out);
  assert.equal(v.ok, true);
});
