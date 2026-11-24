// TMDL parser (plan §7.1): single pass, indentation-based container stack,
// backtick fence tracking. It only *locates* table/column/measure declarations
// and their `///` description lines; it never rebuilds TMDL.

import { splitText, leadingWhitespace, isBlank, measureIndent, indentDepth } from './text.js';
import { NAME_SRC, parseObjectName } from './names.js';

/** @typedef {'table'|'column'|'measure'|'expression'} ObjType */

/**
 * @typedef {Object} TmdlObject
 * @property {string}  key          `${type}|${table}|${name}` lowercased
 * @property {ObjType} type
 * @property {string}  table        parent table name (own name for tables)
 * @property {string}  name         unquoted name
 * @property {number}  declLine     0-based line index of the declaration
 * @property {number}  descStart    first `///` line; === declLine when no description
 * @property {string}  indent       exact whitespace prefix of the declaration line
 * @property {string}  originalDesc description text joined with '\n'
 * @property {string=} expression   expression text (measure / calculated column), capped
 * @property {string=} dataType
 * @property {boolean} isHidden
 * @property {boolean} editable     false for `ref table`
 * @property {string=} dataCategory table `dataCategory` (e.g. Time for a marked date table)
 * @property {string=} queryGroup   expression `queryGroup`
 * @property {string=} resultType   expression `annotation PBI_ResultType` (Table, Text, Function, …)
 */

/**
 * @typedef {Object} ParseResult
 * @property {string[]} lines
 * @property {'\n'|'\r\n'} eol
 * @property {boolean} hasBom
 * @property {boolean} trailingNewline
 * @property {TmdlObject[]} objects
 * @property {{line:number, message:string}[]} warnings
 * @property {boolean} hasCreateOrReplace
 * @property {boolean} hasModel
 * @property {MQueryRange[]} mQueries  Power Query (M) code locations: m partitions and shared expressions
 */

/**
 * @typedef {Object} MQueryRange
 * @property {'partition'|'expression'} kind
 * @property {string} key        partition: `partition|table|name`; expression: same key as its object
 * @property {string} name       partition or expression name
 * @property {string} table      owning table (partition) or '' (expression)
 * @property {string} descKey    object key holding the query description (table or expression)
 * @property {number} declLine   line of `source =` / `expression … =`
 * @property {number} bodyStart  first line of the M body (-1 when the body is inline on declLine)
 * @property {number} bodyEnd    last non-blank line of the M body (inclusive)
 * @property {boolean} fenced
 * @property {boolean} editable  false under `ref`
 * @property {string=} inline    expression body written on the declaration line (e.g. a parameter value)
 */

const CONTAINERS = new Set(['createorreplace', 'database', 'model']);
const TABLE_RE = new RegExp('^(ref\\s+)?table\\s+(' + NAME_SRC + ')(\\s*=.*)?$', 'i');
const CHILD_RE = new RegExp('^(column|measure)\\s+(' + NAME_SRC + ')(\\s*=(.*))?$', 'i');
const EXPR_RE = new RegExp('^(ref\\s+)?expression\\s+(' + NAME_SRC + ')(\\s*=(.*))?$', 'i');
const PART_M_RE = new RegExp('^partition\\s+(' + NAME_SRC + ')\\s*=\\s*m$', 'i');
const SOURCE_RE = /^source\s*=(.*)$/i;
const FENCE_OPEN_RE = /=\s*(`{3,})$/;
const EXPR_MAX_CHARS = 4000;
const EXPR_MAX_LINES = 40;

/** Build the lookup key for an object. */
export function makeKey(type, table, name) {
  return (type + '|' + table + '|' + name).toLowerCase();
}

/**
 * Read the description block directly above `declLine`.
 * @param {string[]} lines
 * @param {number} declLine
 * @param {string} indent
 */
export function readDescription(lines, declLine, indent) {
  const prefix = indent + '///';
  let start = declLine;
  while (start > 0 && lines[start - 1].startsWith(prefix)) start--;
  const parts = [];
  for (let j = start; j < declLine; j++) {
    let rest = lines[j].slice(prefix.length);
    if (rest.startsWith(' ')) rest = rest.slice(1);
    parts.push(rest);
  }
  return { descStart: start, text: parts.join('\n') };
}

function dedent(lines) {
  let min = Infinity;
  for (const l of lines) {
    if (isBlank(l)) continue;
    min = Math.min(min, leadingWhitespace(l).length);
  }
  if (!isFinite(min)) min = 0;
  return lines.map((l) => (isBlank(l) ? '' : l.slice(min)));
}

/**
 * @param {string} raw full text (BOM / CRLF allowed)
 * @returns {ParseResult}
 */
export function parseTmdl(raw) {
  const { lines, eol, hasBom, trailingNewline, mixedEol } = splitText(raw);
  const unit = measureIndent(lines);
  /** @type {TmdlObject[]} */
  const objects = [];
  /** @type {{line:number, message:string}[]} */
  const warnings = [];
  /** @type {{kind:string, depth:number, obj?:TmdlObject, name?:string}[]} */
  const stack = [];
  /** @type {{close:string, line:number}|null} */
  let fence = null;
  /** expression collector for the latest column/measure */
  let collector = null;
  let hasCreateOrReplace = false;
  let hasModel = false;
  /** @type {MQueryRange[]} */
  const mQueries = [];
  /** open M body: {q, stopAt, inFence}; ends at a non-blank line with depth <= stopAt */
  let mBody = null;
  const endMBody = () => {
    if (!mBody) return;
    if (mBody.q.bodyEnd < mBody.q.bodyStart) mBody.q.bodyStart = -1; // empty body
    mQueries.push(mBody.q);
    mBody = null;
  };
  const openMBody = (q, i, stopAt, inFence) => {
    q.bodyStart = i + 1;
    q.bodyEnd = i;
    mBody = { q, stopAt, inFence };
  };

  const finishCollector = () => {
    if (!collector) return;
    const body = dedent(collector.lines);
    while (body.length && body[0] === '') body.shift();
    while (body.length && body[body.length - 1] === '') body.pop();
    let text = body.join('\n');
    if (collector.truncated) text += '\n…';
    if (text.length > EXPR_MAX_CHARS) text = text.slice(0, EXPR_MAX_CHARS) + '…';
    if (text) collector.obj.expression = text;
    collector = null;
  };
  const collect = (line) => {
    if (collector.lines.length >= EXPR_MAX_LINES) {
      collector.truncated = true;
      return;
    }
    collector.lines.push(line.length > EXPR_MAX_CHARS ? line.slice(0, EXPR_MAX_CHARS) : line);
  };

  if (mixedEol) {
    warnings.push({ line: 0, message: 'Line ending campuran terdeteksi (CRLF dan LF). Output tetap memakai byte asli, tetapi hasil parse mungkin tidak akurat.' });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      if (line.trim() === fence.close) {
        fence = null;
        if (collector && collector.inFence) finishCollector();
        if (mBody && mBody.inFence) endMBody();
      } else {
        if (collector && collector.inFence) collect(line);
        if (mBody && mBody.inFence && !isBlank(line)) mBody.q.bodyEnd = i;
      }
      continue;
    }

    if (isBlank(line)) {
      if (collector) collect('');
      continue;
    }

    const ws = leadingWhitespace(line);
    const body = line.slice(ws.length).trimEnd();
    const d = indentDepth(ws, unit);

    // Unfenced M body (partition source / expression): every deeper line belongs to it.
    if (mBody && !mBody.inFence) {
      if (d > mBody.stopAt) {
        mBody.q.bodyEnd = i;
        continue;
      }
      endMBody();
    }

    if (body.startsWith('///')) {
      // `///` never opens a fence or changes context. Deep ones are DAX/M comments
      // inside an unfenced expression: keep them in the expression summary.
      if (collector && !collector.inFence && d >= collector.depth + 2) collect(line);
      continue;
    }

    // Unfenced multi-line expression of the latest column/measure (objDepth + 2 or deeper).
    if (collector && !collector.inFence) {
      if (d >= collector.depth + 2) {
        collect(line);
      } else {
        finishCollector();
      }
    }

    while (stack.length && stack[stack.length - 1].depth >= d) stack.pop();
    const top = stack.length ? stack[stack.length - 1] : null;
    const allContainers = stack.every((e) => e.kind === 'container');
    const kw = body.split(/\s+/)[0].toLowerCase();
    const fenceMatch = FENCE_OPEN_RE.exec(body);
    let m;

    if (CONTAINERS.has(kw) && allContainers) {
      if (kw === 'createorreplace') hasCreateOrReplace = true;
      if (kw === 'model') hasModel = true;
      stack.push({ kind: 'container', depth: d });
    } else if (allContainers && (m = TABLE_RE.exec(body))) {
      const name = parseObjectName(m[2]);
      const isRef = !!m[1];
      const desc = readDescription(lines, i, ws);
      /** @type {TmdlObject} */
      const obj = {
        key: makeKey('table', name, name),
        type: 'table',
        table: name,
        name,
        declLine: i,
        descStart: desc.descStart,
        indent: ws,
        originalDesc: desc.text,
        isHidden: false,
        editable: !isRef,
      };
      objects.push(obj);
      stack.push({ kind: 'table', depth: d, obj, name });
    } else if (allContainers && (m = EXPR_RE.exec(body))) {
      // Shared expression (Power Query parameter / function / staging query).
      const name = parseObjectName(m[2]);
      const desc = readDescription(lines, i, ws);
      /** @type {TmdlObject} */
      const obj = {
        key: makeKey('expression', '', name),
        type: 'expression',
        table: '',
        name,
        declLine: i,
        descStart: desc.descStart,
        indent: ws,
        originalDesc: desc.text,
        isHidden: false,
        editable: !m[1],
      };
      objects.push(obj);
      stack.push({ kind: 'expression', depth: d, obj });
      if (m[3] !== undefined) {
        /** @type {MQueryRange} */
        const rhs = (m[4] || '').trim();
        const q = { kind: 'expression', key: obj.key, name, table: '', descKey: obj.key, declLine: i, bodyStart: -1, bodyEnd: -1, fenced: !!fenceMatch, editable: obj.editable, inline: fenceMatch ? '' : rhs };
        if (fenceMatch) openMBody(q, i, -1, true);
        else if (rhs === '') openMBody(q, i, d + 1, false);
        else mQueries.push(q);
      }
    } else if (top && top.kind === 'table' && d === top.depth + 1 && (m = PART_M_RE.exec(body))) {
      stack.push({ kind: 'mpartition', depth: d, name: parseObjectName(m[1]), table: top.name, tableObj: top.obj });
    } else if (top && top.kind === 'mpartition' && d === top.depth + 1 && (m = SOURCE_RE.exec(body))) {
      /** @type {MQueryRange} */
      const q = {
        kind: 'partition',
        key: ('partition|' + top.table + '|' + top.name).toLowerCase(),
        name: top.name,
        table: top.table,
        descKey: top.tableObj.key,
        declLine: i,
        bodyStart: -1,
        bodyEnd: -1,
        fenced: !!fenceMatch,
        editable: top.tableObj.editable,
      };
      if (fenceMatch) openMBody(q, i, -1, true);
      else if (m[1].trim() === '') openMBody(q, i, d, false);
      else mQueries.push(q);
      stack.push({ kind: 'other', depth: d });
    } else if (top && top.kind === 'table' && d === top.depth + 1 && (m = CHILD_RE.exec(body))) {
      const type = /** @type {ObjType} */ (m[1].toLowerCase());
      const name = parseObjectName(m[2]);
      const desc = readDescription(lines, i, ws);
      /** @type {TmdlObject} */
      const obj = {
        key: makeKey(type, top.name, name),
        type,
        table: /** @type {string} */ (top.name),
        name,
        declLine: i,
        descStart: desc.descStart,
        indent: ws,
        originalDesc: desc.text,
        isHidden: false,
        editable: true,
      };
      objects.push(obj);
      stack.push({ kind: type, depth: d, obj });
      if (m[3] !== undefined) {
        const rhs = (m[4] || '').trim();
        if (fenceMatch) {
          collector = { obj, depth: d, lines: [], inFence: true, truncated: false };
        } else if (rhs === '') {
          collector = { obj, depth: d, lines: [], inFence: false, truncated: false };
        } else {
          obj.expression = rhs.length > EXPR_MAX_CHARS ? rhs.slice(0, EXPR_MAX_CHARS) + '…' : rhs;
        }
      }
    } else {
      // Direct property of a recognised object → lightweight metadata for the UI.
      if (top && top.obj && d === top.depth + 1) {
        const pm = /^([A-Za-z]+)\s*(?::\s*(.*))?$/.exec(body);
        if (pm) {
          const prop = pm[1].toLowerCase();
          if (prop === 'datatype' && pm[2] !== undefined) top.obj.dataType = pm[2].trim();
          if (prop === 'ishidden') top.obj.isHidden = pm[2] === undefined || pm[2].trim().toLowerCase() !== 'false';
          if (prop === 'datacategory' && pm[2] !== undefined) top.obj.dataCategory = pm[2].trim();
          if (prop === 'querygroup' && pm[2] !== undefined) top.obj.queryGroup = parseObjectName(pm[2].trim());
        }
        const am = /^annotation\s+PBI_ResultType\s*=\s*(.+)$/i.exec(body);
        if (am) top.obj.resultType = am[1].trim();
      }
      stack.push({ kind: 'other', depth: d });
    }

    if (fenceMatch) fence = { close: fenceMatch[1], line: i };
  }

  finishCollector();
  endMBody();
  if (fence) {
    warnings.push({ line: fence.line, message: 'Blok ``` dibuka di baris ' + (fence.line + 1) + ' tetapi tidak pernah ditutup.' });
  }

  const seen = new Map();
  for (const o of objects) {
    const prev = seen.get(o.key);
    if (prev) {
      if (!prev.warned) {
        warnings.push({
          line: o.declLine,
          message: 'Objek ' + o.type + ' "' + (o.type === 'table' || o.type === 'expression' ? o.name : o.table + '[' + o.name + ']') +
            '" dideklarasikan lebih dari sekali (baris ' + (prev.line + 1) + ' dan ' + (o.declLine + 1) + '). Semua kemunculan akan ikut diperbarui.',
        });
        prev.warned = true;
      }
    } else {
      seen.set(o.key, { line: o.declLine, warned: false });
    }
  }
  if (objects.length === 0) {
    warnings.push({ line: 0, message: 'Tidak ada table, column, atau measure yang dikenali.' });
  }

  mQueries.sort((a, b) => a.declLine - b.declLine);
  return { lines, eol, hasBom, trailingNewline, objects, warnings, hasCreateOrReplace, hasModel, mQueries };
}
