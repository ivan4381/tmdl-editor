// Spreadsheet round trip for SME work (Excel): objects → rows, rows → matched edits.
// Rows are matched by Type + Table + Name (case-insensitive).

import { normalizeDescription } from './writer.js';

export const SHEET_COLUMNS = [
  { header: 'Table', width: 26 },
  { header: 'Type', width: 10 },
  { header: 'Name', width: 34 },
  { header: 'DataType', width: 12 },
  { header: 'IsHidden', width: 9 },
  { header: 'Expression', width: 50, wrap: true },
  { header: 'Description', width: 70, wrap: true },
];

const EXPR_MAX = 1000;

/**
 * @param {{table:string, type:string, name:string, dataType?:string, isHidden?:boolean, expression?:string}[]} items
 * @param {(item:any)=>string} descOf current description of an item
 * @returns {(string|boolean)[][]}
 */
export function itemsToRows(items, descOf) {
  return items.map((it) => [
    it.table,
    it.type,
    it.name,
    it.dataType ?? '',
    it.isHidden ? 'TRUE' : 'FALSE',
    it.expression ? (it.expression.length > EXPR_MAX ? it.expression.slice(0, EXPR_MAX) + '…' : it.expression) : '',
    normalizeDescription(descOf(it)),
  ]);
}

const HEADER_ALIASES = {
  table: ['table', 'tabel'],
  type: ['type', 'tipe', 'jenis'],
  name: ['name', 'nama'],
  description: ['description', 'deskripsi'],
};
const TYPE_ALIASES = { table: 'table', tabel: 'table', column: 'column', kolom: 'column', measure: 'measure' };

/**
 * Match imported spreadsheet rows to editor items.
 * @param {string[][]} rows first row = header
 * @param {{key:string, type:string, table:string, name:string, editable:boolean}[]} items
 * @param {(key:string)=>string} currentDesc
 * @returns {{matched:number, changed:{key:string, item:any, from:string, to:string}[],
 *   notFound:{line:number, type:string, table:string, name:string}[], readOnly:number, errors:string[]}}
 */
export function matchRows(rows, items, currentDesc) {
  const result = { matched: 0, changed: [], notFound: [], readOnly: 0, errors: [] };
  const headerIdx = rows.findIndex((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
  if (headerIdx < 0) {
    result.errors.push('Sheet kosong.');
    return result;
  }
  const header = rows[headerIdx].map((h) => String(h ?? '').trim().toLowerCase());
  const find = (k) => header.findIndex((h) => HEADER_ALIASES[k].includes(h));
  const idx = { table: find('table'), type: find('type'), name: find('name'), description: find('description') };
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([k]) => k[0].toUpperCase() + k.slice(1));
  if (missing.length) {
    result.errors.push('Kolom wajib tidak ditemukan di baris judul: ' + missing.join(', ') + '.');
    return result;
  }
  const byKey = new Map(items.map((it) => [it.key, it]));
  const seen = new Set();
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (i) => String(row[i] ?? '').trim();
    const typeRaw = cell(idx.type).toLowerCase();
    const type = TYPE_ALIASES[typeRaw] || typeRaw;
    const table = cell(idx.table);
    const name = cell(idx.name);
    if (!type && !table && !name) continue;
    const key = (type + '|' + table + '|' + name).toLowerCase();
    const item = byKey.get(key);
    if (!item) {
      result.notFound.push({ line: r + 1, type, table, name });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (!item.editable) {
      result.readOnly++;
      continue;
    }
    result.matched++;
    const to = normalizeDescription(String(row[idx.description] ?? ''));
    const from = normalizeDescription(currentDesc(key));
    if (to !== from) result.changed.push({ key, item, from, to });
  }
  return result;
}
