import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { tokenizeM, findSteps, stepDisplayName, collectQueries } from '../src/core/mquery.js';
import { parseTmdl, makeKey } from '../src/core/parser.js';
import { applyDescriptions, normalizeDescription } from '../src/core/writer.js';
import { validateRoundTrip } from '../src/core/validator.js';
import { fixture } from './helpers.js';

const kinds = (src) => tokenizeM(src).filter((t) => t.t !== 'ws').map((t) => t.t + ':' + t.v);

test('tokenizeM: strings with "", quoted identifiers, comments, // inside strings', () => {
  assert.deepEqual(kinds('a = "x ""y"" // z" // c'), ['id:a', 'punct:=', 'str:"x ""y"" // z"', 'line:// c']);
  assert.deepEqual(kinds('#"A ""B""" = /* x\n // y */ Table.X'), ['qid:#"A ""B"""', 'punct:=', 'block:/* x\n // y */', 'id:Table.X']);
  assert.deepEqual(kinds('f = (x) => x <> 1'), ['id:f', 'punct:=', 'punct:(', 'id:x', 'punct:)', 'punct:=>', 'id:x', 'punct:<>', 'num:1']);
  assert.deepEqual(kinds('#table(a, {})'), ['id:#table', 'punct:(', 'id:a', 'punct:,', 'punct:{', 'punct:}', 'punct:)']);
  assert.throws(() => tokenizeM('x = "abc'), /String/);
  assert.throws(() => tokenizeM('x = /* abc'), /Komentar/);
});

test('stepDisplayName', () => {
  assert.equal(stepDisplayName('#"Changed ""Type"""'), 'Changed "Type"');
  assert.equal(stepDisplayName('Source'), 'Source');
});

test('findSteps: function header, no let, malformed', () => {
  const f = findSteps(['(x as table) as table =>', 'let', '    a = 1,', '    b = a', 'in', '    b']);
  assert.deepEqual(f.steps.map((s) => [s.name, s.line, s.commentable]), [['a', 2, true], ['b', 3, true]]);
  assert.deepEqual(findSteps(['Source']), { steps: [], error: '' });
  assert.deepEqual(findSteps(['"halo" meta [IsParameterQuery = true]']), { steps: [], error: '' });
  assert.match(findSteps(['let', '    a = (1', 'in', '    a']).error, /Akhir|Kurung/);
  assert.match(findSteps(['let', '    = 1', 'in', '    a']).error, /Struktur/);
  // `let` on the same line as the first step: not describable.
  assert.deepEqual(findSteps(['let a = 1 in a']).steps.map((s) => s.commentable), [false]);
});

test('20 mquery: queries, steps, descriptions and commentable flags', () => {
  const qs = collectQueries(parseTmdl(fixture('20-mquery.tmdl')));
  assert.deepEqual(qs.map((q) => [q.key, q.kind, q.descKey, q.error, q.steps.length]), [
    ['partition|sales|sales', 'partition', 'table|sales|sales', '', 6],
    ['expression||fndouble', 'expression', 'expression||fndouble', '', 0],
    ['expression||staging', 'expression', 'expression||staging', '', 2],
    ['expression||broken', 'expression', 'expression||broken', 'String tidak ditutup.', 0],
  ]);
  const s = qs[0].steps;
  assert.deepEqual(s.map((x) => [x.name, x.originalDesc, x.commentable]), [
    ['Source', 'Ambil data dari server', true],
    ['Filtered "Rows"', '', true], // block comment above is not a description
    ['Nested', '', true], // nested let/in and its commas stay inside the step
    ['Multi', '', true], // blank line separates the stray comment
    ['A', '', true],
    ['B', '', false], // second step on the same line
  ]);
  assert.equal(s[1].key, 'step|partition|sales|sales|#"Filtered ""Rows"""');
  assert.equal(s[0].indent, '\t\t\t\t\t\t    ');
  assert.match(s[3].code, /^\s*Multi =\n\s+Table\.AddColumn\(/);
  assert.match(qs[2].code, /^let\n {4}Source = Excel\.Workbook/);
});

test('20 mquery writer: step descriptions + query descriptions, matches expected, validator ok', () => {
  const input = fixture('20-mquery.tmdl');
  const parsed = parseTmdl(input);
  const step = (q, raw) => 'step|' + q + '|' + raw;
  const edits = new Map([
    [makeKey('table', 'Sales', 'Sales'), 'Penjualan'],
    [step('partition|sales|sales', 'Source'), 'Sumber data penjualan dari SQL Server'],
    [step('partition|sales|sales', '#"Filtered ""Rows"""'), 'Menyaring baris valid\n\nBaris ketiga  \n'],
    [step('partition|sales|sales', 'Multi'), 'Menambah kolom teks'],
    [step('partition|sales|sales', 'A'), 'Konstanta A'],
    [step('partition|sales|sales', 'B'), 'tidak boleh ditulis (satu baris dengan A)'],
    [step('expression||staging', 'Sheet'), 'Ambil sheet pertama'],
    [makeKey('expression', '', 'Staging'), 'Query staging Excel'],
    [makeKey('expression', '', 'fnDouble'), ''],
  ]);
  const out = applyDescriptions(parsed, edits);
  assert.equal(out, fixture('20-mquery.expected.tmdl'));
  assert.deepEqual(validateRoundTrip(input, out), { ok: true, errors: [] });
  const again = collectQueries(parseTmdl(out));
  assert.equal(again[0].steps[1].originalDesc, normalizeDescription('Menyaring baris valid\n\nBaris ketiga'));
  assert.equal(again[0].steps[3].originalDesc, 'Menambah kolom teks');
  assert.equal(again[2].steps[1].originalDesc, 'Ambil sheet pertama');
  // Removing descriptions again restores the original bytes (except the ones that were there).
  const back = new Map([...edits.keys()].map((k) => [k, '']));
  back.set(step('partition|sales|sales', 'Source'), 'Ambil data dari server');
  back.set(makeKey('expression', '', 'fnDouble'), 'Fungsi uji');
  const restored = applyDescriptions(parseTmdl(out), back);
  assert.equal(restored, input);
});

test('17 full-model: step description on fenced expression and partition, validator ok', () => {
  const input = fixture('17-full-model.tmdl');
  const edits = new Map([
    ['step|expression||fn transform dot|fnTransformDOT', 'Fungsi transformasi DOT'],
    ['step|partition|measures table|measures table|#"Removed Columns"', 'Menghapus kolom bantu'],
    ['step|partition|vl06f+mb51|vl06f+mb51|Filter_NonZeroQuantity', ''],
  ]);
  const out = applyDescriptions(parseTmdl(input), edits);
  assert.ok(out.includes('\t\t\t\t    // Fungsi transformasi DOT\r\n\t\t\t\t    fnTransformDOT ='));
  assert.ok(out.includes('\t\t\t\t\t\t    // Menghapus kolom bantu\r\n\t\t\t\t\t\t    #"Removed Columns"'));
  assert.ok(!out.includes('⚠️ RISIKO'));
  assert.ok(out.includes('// Jika salah satu sumber') === false);
  assert.deepEqual(validateRoundTrip(input, out).errors, []);
});

test('validator rejects changes to M code and misplaced comments', () => {
  const input = fixture('20-mquery.tmdl');
  const fail = (bad, re) => {
    const v = validateRoundTrip(input, bad);
    assert.equal(v.ok, false);
    if (re) assert.ok(v.errors.some((e) => re.test(e.message)), v.errors.map((e) => e.message).join(' | '));
  };
  fail(input.replace('[Qty (MT)] > 0', '[Qty (MT)] >= 0'), /di luar deskripsi/);
  fail(input.replace('"Teks",', '// sisipan di tengah step\n\t\t\t\t\t\t            "Teks",'), /di luar deskripsi/);
  fail(input.replace('    Nested = let a = 1, b = 2 in a + b,\n', ''), /Struktur query/);
  fail(input.replace('"http://x/y"', '"http://x/z"'));
  // Comment inside the string stays code.
  fail(input.replace('// di dalam string', '// diubah'));
});

test('idempotent with step edits equal to the original descriptions (all fixtures)', () => {
  const names = readdirSync(new URL('./fixtures/', import.meta.url)).filter((n) => n.endsWith('.tmdl') && !n.includes('.expected.'));
  for (const n of names) {
    const input = fixture(n);
    const parsed = parseTmdl(input);
    const same = new Map();
    for (const o of parsed.objects) same.set(o.key, o.originalDesc);
    for (const q of collectQueries(parsed)) for (const st of q.steps) same.set(st.key, st.originalDesc);
    assert.equal(applyDescriptions(parsed, same), input, n);
  }
});

import { queryCodeWithDescriptions } from '../src/core/mquery.js';

test('queryCodeWithDescriptions matches what the writer produces', () => {
  const input = fixture('20-mquery.tmdl');
  const parsed = parseTmdl(input);
  const qs = collectQueries(parsed);
  const edits = new Map([
    ['step|partition|sales|sales|Source', 'Sumber data penjualan dari SQL Server'],
    ['step|partition|sales|sales|#"Filtered ""Rows"""', 'Menyaring baris valid\n\nBaris ketiga'],
    ['step|partition|sales|sales|Multi', 'Menambah kolom teks'],
    ['step|expression||staging|Sheet', 'Ambil sheet pertama'],
  ]);
  const after = collectQueries(parseTmdl(applyDescriptions(parsed, edits)));
  for (let i = 0; i < qs.length; i++) {
    const shown = queryCodeWithDescriptions(parsed.lines, qs[i], (st) => {
      if (!edits.has(st.key)) return null;
      const d = normalizeDescription(edits.get(st.key));
      return d === normalizeDescription(st.originalDesc) ? null : d;
    });
    assert.equal(shown, after[i].code, qs[i].key);
  }
  // No edits → original code.
  assert.equal(queryCodeWithDescriptions(parsed.lines, qs[0], () => null), qs[0].code);
});
