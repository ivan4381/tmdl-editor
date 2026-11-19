import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildZip, readZip, crc32 } from '../src/core/zip.js';
import { buildXlsx, readXlsx, colName, colIndex } from '../src/core/xlsx.js';
import { SHEET_COLUMNS, itemsToRows, matchRows } from '../src/core/sheet.js';
import { parseTmdl } from '../src/core/parser.js';
import { buildItems } from '../src/core/items.js';
import { fixture } from './helpers.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deflateRaw(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Build a ZIP with deflated entries (like Excel does), using our stored writer then patching method/sizes. */
async function deflatedZip(entries) {
  // Hand-rolled: local header + data + central directory, method 8.
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = enc.encode(e.data);
    const comp = await deflateRaw(raw);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(8, 8, true);
    lv.setUint32(14, crc32(raw), true); lv.setUint32(18, comp.length, true); lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(raw), true); cv.setUint32(20, comp.length, true); cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, offset, true); ch.set(name, 46);
    parts.push(lh, comp); central.push(ch);
    offset += lh.length + comp.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

test('crc32 known value', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('zip stored round trip with UTF-8 names', async () => {
  const z = buildZip([{ name: 'a.txt', data: 'halo' }, { name: 'dir/ü.xml', data: '<x/>' }]);
  const files = await readZip(z);
  assert.deepEqual([...files.keys()], ['a.txt', 'dir/ü.xml']);
  assert.equal(dec.decode(files.get('dir/ü.xml')), '<x/>');
});

test('colName / colIndex', () => {
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(colName), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  for (let i = 0; i < 800; i++) assert.equal(colIndex(colName(i)), i);
});

test('xlsx build → read round trip keeps text exactly (newlines, quotes, unicode, XML chars, spaces)', async () => {
  const rows = [
    ['Sales', 'measure', 'Total Sales', '', 'FALSE', 'SUM(Sales[Amount])', 'Baris 1\nBaris "2" & <3> 🚀'],
    ['Sales', 'column', '=SUM(A1)', 'int64', 'TRUE', '', '  spasi di depan'],
    ['Sales', 'table', 'Sales', '', 'FALSE', '', ''],
  ];
  const bytes = buildXlsx({ sheetName: 'Deskripsi', columns: SHEET_COLUMNS, rows });
  const back = await readXlsx(bytes);
  assert.deepEqual(back[0], SHEET_COLUMNS.map((c) => c.header));
  assert.deepEqual(back[1], rows[0]);
  assert.equal(back[2][2], '=SUM(A1)'); // stored as text, never a formula
  assert.equal(back[2][6], '  spasi di depan');
  assert.equal(back[3].length <= 7, true);
  const files = await readZip(bytes);
  const sheet = dec.decode(files.get('xl/worksheets/sheet1.xml'));
  assert.ok(!sheet.includes('<f>'), 'no formulas');
  assert.ok(sheet.includes('state="frozen"'));
  assert.ok(sheet.includes('<autoFilter ref="A1:G4"/>'));
});

test('readXlsx: Excel-style file (deflate, sharedStrings with rich text, prefixes, missing r attrs, _x000D_)', async () => {
  const ns = 'xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const z = await deflatedZip([
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><x:workbook ${ns}><x:sheets><x:sheet name="Data" sheetId="7" r:id="rId9"/></x:sheets></x:workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="x/worksheet" Target="/xl/worksheets/data.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: `<x:sst ${ns}><x:si><x:t>Table</x:t></x:si><x:si><x:r><x:rPr><x:b/></x:rPr><x:t>Desc</x:t></x:r><x:r><x:t xml:space="preserve">ription</x:t></x:r></x:si><x:si><x:t>a_x000D_
b &amp; c</x:t><x:rPh><x:t>IGNORED</x:t></x:rPh></x:si></x:sst>` },
    { name: 'xl/worksheets/data.xml', data: `<x:worksheet ${ns}><x:sheetData><x:row><x:c t="s"><x:v>0</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row><x:row r="3"><x:c r="A3"><x:v>42</x:v></x:c><x:c r="B3" t="b"><x:v>1</x:v></x:c><x:c r="C3" t="s"><x:v>2</x:v></x:c></x:row></x:sheetData></x:worksheet>` },
  ]);
  const rows = await readXlsx(z);
  assert.deepEqual(rows[0], ['Table', '', 'Description']);
  assert.deepEqual(rows[1], []);
  assert.deepEqual(rows[2], ['42', 'TRUE', 'a\nb & c']);
});

test('readXlsx rejects non-xlsx input', async () => {
  await assert.rejects(readXlsx(enc.encode('not a zip')), /xlsx/i);
});

test('itemsToRows + matchRows: export, edit, import', async () => {
  const parsed = parseTmdl(fixture('02-existing-desc.tmdl'));
  const { items, byKey } = buildItems(parsed);
  const edits = new Map();
  const desc = (it) => (edits.has(it.key) ? edits.get(it.key) : it.originalDesc);
  const rows = itemsToRows(items, desc);
  assert.equal(rows[2][6], 'Baris pertama\n\nBaris ketiga setelah baris kosong');
  const bytes = buildXlsx({ columns: SHEET_COLUMNS, rows });
  const back = await readXlsx(bytes);
  back[3][6] = 'Total baru';
  back[4][0] = 'SALES'; back[4][1] = 'Measure'; back[4][2] = 'qty'; // case-insensitive match
  back.push(['Nope', 'column', 'X', '', '', '', 'y']);
  const m = matchRows(back, items, (k) => desc(byKey.get(k)));
  assert.deepEqual(m.errors, []);
  assert.equal(m.matched, 4);
  assert.deepEqual(m.changed.map((c) => [c.key, c.to]), [['measure|sales|total sales', 'Total baru']]);
  assert.deepEqual(m.notFound.map((n) => n.name), ['X']);
});

test('matchRows: Indonesian headers and type aliases, read-only, missing columns', () => {
  const items = [
    { key: 'column|sales|amount', type: 'column', table: 'Sales', name: 'Amount', editable: true },
    { key: 'table|ref|ref', type: 'table', table: 'Ref', name: 'Ref', editable: false },
  ];
  const m = matchRows([['', ''], ['Tabel', 'Tipe', 'Nama', 'Deskripsi'], ['Sales', 'Kolom', 'Amount', 'Nilai'], ['Ref', 'Tabel', 'Ref', 'x']], items, () => '');
  assert.equal(m.matched, 1);
  assert.equal(m.readOnly, 1);
  assert.equal(m.changed[0].to, 'Nilai');
  const bad = matchRows([['Table', 'Name']], items, () => '');
  assert.match(bad.errors[0], /Type, Description/);
  assert.match(matchRows([], items, () => '').errors[0], /kosong/);
});
