// Minimal .xlsx writer/reader (Office Open XML SpreadsheetML), no dependencies.
// Writer: one sheet, inline strings (never interpreted as formulas), bold frozen
// header, autofilter, column widths, wrapped text. Reader: first sheet, shared
// strings, inline strings, numbers/booleans; tolerant of namespace prefixes.

import { buildZip, readZip } from './zip.js';

const MAX_CELL = 32767;

/** Escape text for XML element content; drop characters XML 1.0 forbids. */
function xmlText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlAttr(s) {
  return xmlText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

/** 0 → A, 25 → Z, 26 → AA */
export function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A → 0, AA → 26 */
export function colIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * @param {{sheetName?:string, columns:{header:string, width?:number, wrap?:boolean}[], rows:(string|number|boolean|null|undefined)[][]}} spec
 * @returns {Uint8Array}
 */
export function buildXlsx(spec) {
  const sheetName = (spec.sheetName || 'Sheet1').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const cols = spec.columns;
  const lastCol = colName(cols.length - 1);
  const lastRow = spec.rows.length + 1;

  const cell = (ref, value, style) => {
    if (value === null || value === undefined || value === '') return style ? `<c r="${ref}" s="${style}"/>` : '';
    if (typeof value === 'number' && isFinite(value)) return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}" t="b"${style ? ` s="${style}"` : ''}><v>${value ? 1 : 0}</v></c>`;
    let s = String(value);
    if (s.length > MAX_CELL) s = s.slice(0, MAX_CELL - 1) + '…';
    const sp = /^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '';
    return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${sp}>${xmlText(s)}</t></is></c>`;
  };

  const rowsXml = [];
  rowsXml.push(`<row r="1">${cols.map((c, i) => cell(colName(i) + '1', c.header, 1)).join('')}</row>`);
  spec.rows.forEach((r, ri) => {
    const rn = ri + 2;
    rowsXml.push(`<row r="${rn}">${cols.map((c, i) => cell(colName(i) + rn, r[i], c.wrap ? 2 : 3)).join('')}</row>`);
  });

  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<dimension ref="A1:${lastCol}${lastRow}"/>`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${rowsXml.join('')}</sheetData>`
    + `<autoFilter ref="A1:${lastCol}${lastRow}"/>`
    + '</worksheet>';

  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets>`
    + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${xmlText(sheetName.replace(/'/g, "''"))}'!$A$1:$${lastCol}$${lastRow}</definedName></definedNames>`
    + '</workbook>';

  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFE6EDFC"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="4">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>'
    + '</cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';

  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>',
    },
    { name: 'xl/workbook.xml', data: workbook },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        + '</Relationships>',
    },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

// ---------------------------------------------------------------- reader

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** OOXML escapes some characters as _xHHHH_ (e.g. _x000D_ for CR). */
function decodeOoxml(s) {
  return s.replace(/_x([0-9a-fA-F]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Concatenate every <t>…</t> in a fragment (rich text runs), skipping phonetic runs. */
function textRuns(fragment) {
  const clean = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(clean))) out += m[1] ? decodeOoxml(decodeXml(m[1])) : '';
  return out;
}

function attr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? decodeXml(m[1]) : null;
}

/** Drop namespace prefixes from element names (<x:c> → <c>), keep attributes. */
function stripPrefixes(xml) {
  return xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Read the first worksheet of an .xlsx file as a 2D array of strings.
 * @param {Uint8Array} bytes
 * @returns {Promise<string[][]>}
 */
export async function readXlsx(bytes) {
  const files = await readZip(bytes);
  const dec = new TextDecoder();
  const get = (path) => {
    const key = [...files.keys()].find((k) => k.toLowerCase() === path.toLowerCase());
    return key ? stripPrefixes(dec.decode(files.get(key))) : null;
  };

  const workbook = get('xl/workbook.xml');
  if (!workbook) throw new Error('Bukan file Excel (.xlsx): workbook.xml tidak ditemukan.');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const firstSheet = /<sheet\b([^>]*)\/?>/.exec(workbook);
  const rels = get('xl/_rels/workbook.xml.rels');
  if (firstSheet && rels) {
    const rid = attr(firstSheet[1], 'r:id') || attr(firstSheet[1], 'id');
    const relRe = /<Relationship\b([^>]*)\/?>/g;
    let m;
    while ((m = relRe.exec(rels))) {
      if (attr(m[1], 'Id') === rid) {
        sheetPath = resolvePath('xl/workbook.xml', attr(m[1], 'Target') || '');
        break;
      }
    }
  }
  const sheet = get(sheetPath);
  if (!sheet) throw new Error('Sheet pertama tidak ditemukan di file Excel.');

  const shared = [];
  const sst = get('xl/sharedStrings.xml');
  if (sst) {
    const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let m;
    while ((m = siRe.exec(sst))) shared.push(m[1] ? textRuns(m[1]) : '');
  }

  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  let nextRow = 0;
  while ((rm = rowRe.exec(sheet))) {
    const rAttr = attr(rm[1], 'r');
    const ri = rAttr ? parseInt(rAttr, 10) - 1 : nextRow;
    nextRow = ri + 1;
    const row = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let nextCol = 0;
    while ((cm = cellRe.exec(rm[2] || ''))) {
      const ref = attr(cm[1], 'r');
      const ci = ref ? colIndex(ref.replace(/\d+/g, '')) : nextCol;
      nextCol = ci + 1;
      const t = attr(cm[1], 't');
      const body = cm[2] || '';
      const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
      const v = vm ? decodeXml(vm[1]) : '';
      let value;
      if (t === 's') value = shared[parseInt(v, 10)] ?? '';
      else if (t === 'inlineStr') value = textRuns(body);
      else if (t === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
      else if (t === 'str' || t === 'e') value = decodeOoxml(v);
      else value = v;
      while (row.length < ci) row.push('');
      row[ci] = value.replace(/\r\n?/g, '\n');
    }
    while (rows.length < ri) rows.push([]);
    rows[ri] = row;
  }
  return rows;
}
