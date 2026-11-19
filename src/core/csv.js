// CSV export / import for SME round trips (plan §7.4). RFC 4180 quoting,
// UTF-8 BOM for Excel, `;` (default, Indonesian Excel locale) or `,`.

import { normalizeDescription } from './writer.js';

export const CSV_COLUMNS = ['Table', 'Type', 'Name', 'DataType', 'IsHidden', 'Expression', 'Description'];

/**
 * @param {string} value
 * @param {string} delimiter
 */
function quoteField(value, delimiter) {
  const s = value == null ? '' : String(value);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * @param {{table:string, type:string, name:string, dataType?:string, isHidden?:boolean, expression?:string, description:string}[]} rows
 * @param {{delimiter?:string, bom?:boolean}} [opt]
 * @returns {string}
 */
export function toCsv(rows, opt = {}) {
  const delimiter = opt.delimiter ?? ';';
  const lines = [CSV_COLUMNS.map((c) => quoteField(c, delimiter)).join(delimiter)];
  for (const r of rows) {
    lines.push([
      r.table,
      r.type,
      r.name,
      r.dataType ?? '',
      r.isHidden ? 'TRUE' : 'FALSE',
      r.expression ?? '',
      r.description ?? '',
    ].map((v) => quoteField(v, delimiter)).join(delimiter));
  }
  return (opt.bom === false ? '' : '﻿') + lines.join('\r\n') + '\r\n';
}

/**
 * Detect the delimiter from the header line (outside quotes).
 * @param {string} text
 */
export function detectDelimiter(text) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ';';
  for (const d of [';', ',', '\t']) if (counts[d] > counts[best]) best = d;
  return best;
}

/**
 * Parse CSV text (RFC 4180, multi-line cells, BOM tolerated).
 * @param {string} raw
 * @param {string=} delimiter auto-detected when omitted
 * @returns {{delimiter:string, rows:string[][]}}
 */
export function parseCsv(raw, delimiter) {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  const d = delimiter ?? detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      i++;
    } else if (ch === d) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty lines.
  return { delimiter: d, rows: rows.filter((r) => !(r.length === 1 && r[0] === '')) };
}

/**
 * Match imported CSV rows to parsed objects by Type|Table|Name (case-insensitive).
 * @param {string} raw CSV text
 * @param {{key:string, type:string, table:string, name:string, editable:boolean}[]} items
 * @param {(key:string)=>string} currentDesc current description for a key
 * @returns {{delimiter:string, matched:number, changed:{key:string, item:any, from:string, to:string}[],
 *   notFound:{line:number, type:string, table:string, name:string}[], readOnly:number, errors:string[]}}
 */
export function matchCsv(raw, items, currentDesc) {
  const { delimiter, rows } = parseCsv(raw);
  const result = { delimiter, matched: 0, changed: [], notFound: [], readOnly: 0, errors: [] };
  if (rows.length === 0) {
    result.errors.push('File CSV kosong.');
    return result;
  }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const iTable = col('table');
  const iType = col('type');
  const iName = col('name');
  const iDesc = col('description');
  const missing = [['Table', iTable], ['Type', iType], ['Name', iName], ['Description', iDesc]].filter(([, i]) => i < 0).map(([n]) => n);
  if (missing.length) {
    result.errors.push('Kolom wajib tidak ditemukan di header: ' + missing.join(', ') + '.');
    return result;
  }
  const byKey = new Map(items.map((it) => [it.key, it]));
  const seen = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const type = (row[iType] ?? '').trim().toLowerCase();
    const table = (row[iTable] ?? '').trim();
    const name = (row[iName] ?? '').trim();
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
    const to = normalizeDescription(row[iDesc] ?? '');
    const from = normalizeDescription(currentDesc(key));
    if (to !== from) result.changed.push({ key, item, from, to });
  }
  return result;
}
