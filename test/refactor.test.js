import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REFACTOR_PROMPT, refactorSystemPrompt, buildRefactorMessage, parseRefactorResponse, unmask, countCodeLines, analyzeRefactor, pqFileName } from '../src/core/refactor.js';
import { parseTmdl } from '../src/core/parser.js';
import { collectQueries } from '../src/core/mquery.js';
import { fixture } from './helpers.js';

test('refactorSystemPrompt: owner prompt kept, language parameter, app rules + JSON reply', () => {
  const id = refactorSystemPrompt('id');
  const en = refactorSystemPrompt('en');
  for (const p of [id, en]) {
    assert.ok(!p.includes('{LANG}') && !p.includes('{SUMMARY}'));
    assert.ok(p.includes('Rename all steps to meaningful names using CamelCase'));
    assert.ok(p.includes('prefix the step name with `Filter_`'));
    assert.ok(p.includes('#"Changed Type1" → ChangedType1'));
    assert.ok(p.includes('Data Quality Awareness'));
    assert.ok(p.includes('"refactoredCode"') && p.includes('"alternativeCode"') && p.includes('"explanation"'));
    assert.ok(p.includes('RangeStart/RangeEnd'));
    assert.ok(p.includes('blank line between the summary comment'));
  }
  assert.ok(id.includes('The summary must be written in Bahasa Indonesia') && id.includes('// Query ini <penjelasan'));
  assert.ok(en.includes('All comments must be written in English') && en.includes('// This query <short') && !en.includes('Bahasa Indonesia'));
  assert.ok(REFACTOR_PROMPT.startsWith('Goal:\nAct as a Power Query (M language) expert'));
});

test('buildRefactorMessage masks literals and keeps a restore map', () => {
  const q = collectQueries(parseTmdl(fixture('20-mquery.tmdl')))[0];
  const m = buildRefactorMessage(q, { mask: true, businessContext: 'Penjualan' });
  assert.ok(m.user.startsWith('Query name: Sales\nBusiness context: Penjualan\n\nM code:\nlet'));
  assert.ok(!m.user.includes('srv.contoso.local') && m.user.includes('"<SERVER_1>"'));
  assert.equal(m.restore.get('"<SERVER_1>"'), '"srv.contoso.local"');
  assert.equal(m.restore.get('"<URL_1>"'), '"http://x/y"');
  const plain = buildRefactorMessage(q, { mask: false });
  assert.ok(plain.user.includes('srv.contoso.local'));
  assert.equal(plain.restore.size, 0);
});

test('parseRefactorResponse: JSON, fenced code inside JSON, markdown fallback', () => {
  const j = parseRefactorResponse(JSON.stringify({ refactoredCode: '```m\nlet\n    A = 1\nin\n    A\n```', alternativeCode: '', explanation: '- satu\n- dua' }));
  assert.equal(j.code, 'let\n    A = 1\nin\n    A');
  assert.equal(j.alternative, '');
  assert.equal(j.explanation, '- satu\n- dua');
  const md = parseRefactorResponse('Hasil:\n```powerquery\nlet\n    A = 1\nin\n    A\n```\nAlternatif:\n```m\nlet A = 1 in A\n```\nPenjelasan singkat.');
  assert.equal(md.code, 'let\n    A = 1\nin\n    A');
  assert.equal(md.alternative, 'let A = 1 in A');
  assert.match(md.explanation, /Penjelasan singkat/);
  assert.equal(parseRefactorResponse('tidak ada kode').code, '');
});

test('unmask restores literals and reports leftovers', () => {
  const restore = new Map([['"<SERVER_1>"', '"srv.local"'], ['"<URL_1>"', '"https://a.b/c"']]);
  const r = unmask('S = Sql.Database("<SERVER_1>", "db"), U = Web.Contents("<URL_1>"), X = "<PATH_9>"', restore);
  assert.equal(r.code, 'S = Sql.Database("srv.local", "db"), U = Web.Contents("https://a.b/c"), X = "<PATH_9>"');
  assert.deepEqual(r.left, ['<PATH_9>']);
});

test('countCodeLines ignores comments and blank lines, counts multi-line strings', () => {
  assert.equal(countCodeLines('let\n    // c\n    A = 1,\n\n    /* x\n y */\n    B = "a\nb"\nin\n    B'), 6);
  assert.equal(countCodeLines(''), 0);
  assert.equal(countCodeLines('let\n    A = "unterminated\nin A'), 3); // fallback when not tokenisable
});

const ORIGINAL = `let
    Source = Sql.Database("srv.local", "Sales"),
    #"Filtered Rows" = Table.SelectRows(Source, each [Date] >= RangeStart and [Date] < RangeEnd),
    #"Merged" = Table.NestedJoin(#"Filtered Rows", {"K"}, #"Dim Customer", {"K"}, "C", JoinKind.LeftOuter)
in
    #"Merged"`;

test('analyzeRefactor: all checks pass for a faithful refactor; stats exclude comments/blank lines', () => {
  const good = `let
    // Query ini mengambil penjualan dari SQL Server

    // Mengambil tabel penjualan
    Source = Sql.Database("srv.local", "Sales"),

    // Menyaring periode incremental refresh
    Filter_PeriodRows = Table.SelectRows(Source, each [Date] >= RangeStart and [Date] < RangeEnd),

    // Menggabungkan dengan dimensi pelanggan
    MergeCustomer = Table.NestedJoin(Filter_PeriodRows, {"K"}, #"Dim Customer", {"K"}, "C", JoinKind.LeftOuter)
in
    MergeCustomer`;
  const a = analyzeRefactor(ORIGINAL, good, { queryNames: ['Dim Customer', 'Other'] });
  assert.ok(a.checks.every((c) => c.ok), JSON.stringify(a.checks));
  assert.deepEqual(a.checks.map((c) => c.label), ['Struktur let … in valid', 'Sumber data sama', 'Referensi ke query lain dipertahankan', 'Filter RangeStart/RangeEnd dipertahankan']);
  assert.deepEqual(a.stats, { linesBefore: 6, linesAfter: 6, stepsBefore: 3, stepsAfter: 3 });
});

test('analyzeRefactor flags changed source, lost reference, lost RangeStart, parse errors, leftover placeholders', () => {
  const bad = `let
    Source = Sql.Database("srv2.local", "Sales"),
    Rows = Table.SelectRows(Source, each [Date] > #date(2020,1,1))
in
    Rows`;
  const a = analyzeRefactor(ORIGINAL, bad, { queryNames: ['Dim Customer'], leftPlaceholders: ['<URL_1>'] });
  const byLabel = Object.fromEntries(a.checks.map((c) => [c.label, c]));
  assert.equal(byLabel['Sumber data berubah'].ok, false);
  assert.equal(byLabel['Referensi ke query lain hilang'].detail, 'Dim Customer');
  assert.equal(byLabel['Filter RangeStart/RangeEnd hilang'].ok, false);
  assert.equal(byLabel['Placeholder sensor tidak bisa dikembalikan'].detail, '<URL_1>');
  const broken = analyzeRefactor(ORIGINAL, 'let\n    A = (1\nin\n    A');
  assert.equal(broken.checks[0].label, 'Kode hasil tidak bisa diurai');
  assert.equal(broken.checks[0].ok, false);
});

test('pqFileName', () => {
  assert.equal(pqFileName('VL06F+MB51', '.refactor'), 'VL06F+MB51.refactor.pq');
  assert.equal(pqFileName('a/b:c?', ''), 'a_b_c_.pq');
});
