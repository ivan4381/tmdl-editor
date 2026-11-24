// Power Query (M) step descriptions. Pure functions, no DOM.
//
// A step description is the block of whole-line `//` comments directly above a
// step of the top-level `let … in` (that is how Power Query stores the step
// "Description" from Applied Steps → Properties). Only steps whose name starts
// its own line can be described; anything that cannot be tokenised is skipped,
// never written.

import { leadingWhitespace, isBlank } from './text.js';

/**
 * @typedef {{t:'ws'|'line'|'block'|'str'|'qid'|'id'|'num'|'punct'|'other', v:string, s:number, e:number}} MToken
 */

const PUNCT3 = ['...'];
const PUNCT2 = ['=>', '<=', '>=', '<>', '..', '??'];

/**
 * Tokenise M source. Unterminated strings / comments throw.
 * @param {string} src
 * @returns {MToken[]}
 */
export function tokenizeM(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  const push = (t, s, e) => out.push({ t, v: src.slice(s, e), s, e });
  while (i < n) {
    const c = src[i];
    const s = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ' || c === '﻿') {
      while (i < n && /[ \t\n\r ﻿]/.test(src[i])) i++;
      push('ws', s, i);
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      push('line', s, i);
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Komentar /* tidak ditutup.');
      i = end + 2;
      push('block', s, i);
    } else if (c === '"' || (c === '#' && src[i + 1] === '"')) {
      i += c === '#' ? 2 : 1;
      for (;;) {
        if (i >= n) throw new Error('String tidak ditutup.');
        if (src[i] === '"') {
          if (src[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      push(c === '#' ? 'qid' : 'str', s, i);
    } else if (/[A-Za-z_#]/.test(c)) {
      i++;
      while (i < n && /[A-Za-z0-9_.]/.test(src[i])) i++;
      push('id', s, i);
    } else if (/[0-9]/.test(c)) {
      i++;
      while (i < n && /[0-9A-Za-z.]/.test(src[i])) i++;
      push('num', s, i);
    } else {
      const three = src.slice(i, i + 3);
      const two = src.slice(i, i + 2);
      if (PUNCT3.includes(three)) i += 3;
      else if (PUNCT2.includes(two)) i += 2;
      else i++;
      push(/[=,;()[\]{}+\-*/<>&?@!.]/.test(c) ? 'punct' : 'other', s, i);
    }
  }
  return out;
}

/** Unquote a step name token (#"Changed Type" → Changed Type). */
export function stepDisplayName(raw) {
  return raw.startsWith('#"') ? raw.slice(2, -1).replace(/""/g, '"') : raw;
}

/**
 * Find the steps of the top-level `let … in` in an M body.
 * @param {string[]} lines body lines
 * @returns {{steps:{name:string, raw:string, line:number, endLine:number, commentable:boolean}[], error:string}}
 *   line/endLine are indexes into `lines`; error is '' when the structure was recognised
 *   (a body without `let` yields no steps and no error).
 */
export function findSteps(lines) {
  const src = lines.join('\n');
  let tokens;
  try {
    tokens = tokenizeM(src);
  } catch (e) {
    return { steps: [], error: e.message };
  }
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const sig = tokens.filter((t) => t.t !== 'ws' && t.t !== 'line' && t.t !== 'block');
  const isKw = (t, kw) => t && t.t === 'id' && t.v === kw;
  const OPEN = { '(': ')', '[': ']', '{': '}' };

  // First `let` outside any bracket (allows a function header `(x) as table => let …`).
  let depth = 0;
  let k = 0;
  for (; k < sig.length; k++) {
    const t = sig[k];
    if (t.t === 'punct' && OPEN[t.v]) depth++;
    else if (t.t === 'punct' && /[)\]}]/.test(t.v)) depth--;
    else if (depth === 0 && isKw(t, 'let')) break;
  }
  if (k >= sig.length) return { steps: [], error: '' };

  const steps = [];
  let p = k + 1;
  for (;;) {
    const nameTok = sig[p];
    const eq = sig[p + 1];
    if (!nameTok || !(nameTok.t === 'id' || nameTok.t === 'qid') || !eq || eq.t !== 'punct' || eq.v !== '=') {
      return { steps: [], error: 'Struktur let … in tidak dikenali.' };
    }
    // Scan the step expression to the next top-level `,` or the closing `in`.
    let q = p + 2;
    let br = 0;
    let lets = 0;
    let last = eq;
    for (; q < sig.length; q++) {
      const t = sig[q];
      if (t.t === 'punct' && OPEN[t.v]) br++;
      else if (t.t === 'punct' && /[)\]}]/.test(t.v)) {
        br--;
        if (br < 0) return { steps: [], error: 'Kurung tidak seimbang.' };
      } else if (br === 0 && isKw(t, 'let')) lets++;
      else if (br === 0 && isKw(t, 'in')) {
        if (lets === 0) break;
        lets--;
      } else if (br === 0 && lets === 0 && t.t === 'punct' && t.v === ',') break;
      last = t;
    }
    if (q >= sig.length) return { steps: [], error: 'Akhir let … in tidak ditemukan.' };
    const line = lineOf(nameTok.s);
    const firstOnLine = lines[line].slice(0, nameTok.s - lineStarts[line]).trim() === '';
    steps.push({ name: stepDisplayName(nameTok.v), raw: nameTok.v, line, endLine: lineOf(last.e - 1), commentable: firstOnLine });
    if (isKw(sig[q], 'in')) break;
    p = q + 1;
  }
  // Two steps on one line cannot both be described.
  for (let i = 1; i < steps.length; i++) if (steps[i].line === steps[i - 1].endLine) steps[i].commentable = false;

  // Lines that are a single `//` comment from their first non-blank character.
  steps.commentLines = new Set();
  for (const t of tokens) {
    if (t.t !== 'line') continue;
    const ln = lineOf(t.s);
    if (lines[ln].slice(0, t.s - lineStarts[ln]).trim() === '') steps.commentLines.add(ln);
  }
  return { steps, error: '' };
}

/**
 * Read the `//` description block directly above a step (blank line breaks it).
 * @param {string[]} lines
 * @param {number} stepLine
 * @param {number} floor first line that may belong to the block
 * @param {Set<number>} commentLines
 */
export function readStepDescription(lines, stepLine, floor, commentLines) {
  let start = stepLine;
  while (start - 1 >= floor && commentLines.has(start - 1)) start--;
  const parts = [];
  for (let j = start; j < stepLine; j++) {
    let rest = lines[j].trimStart().slice(2);
    if (rest.startsWith(' ')) rest = rest.slice(1);
    parts.push(rest.replace(/\s+$/, ''));
  }
  return { descStart: start, text: parts.join('\n') };
}

/**
 * @typedef {Object} MStep
 * @property {string} key          `step|<queryKey>|<raw step name>` (step names are case-sensitive in M)
 * @property {string} name
 * @property {number} index        1-based position in Applied Steps
 * @property {number} line         absolute line of the step name
 * @property {number} descStart    absolute first `//` line; === line when none
 * @property {string} indent       exact whitespace prefix of the step line
 * @property {string} originalDesc
 * @property {boolean} commentable
 * @property {string} code         step code (dedented, capped) for context
 */

/**
 * @typedef {Object} MQuery
 * @property {string} key
 * @property {'partition'|'expression'} kind
 * @property {string} name
 * @property {string} table
 * @property {string} descKey      object key whose `///` is the query description
 * @property {boolean} editable
 * @property {string} code         full M body (dedented), '' when inline
 * @property {MStep[]} steps
 * @property {string} error        why steps could not be recognised ('' when fine)
 * @property {string} inline       expression written on the declaration line ('' otherwise)
 * @property {string} queryGroup   Power Query group of an expression
 * @property {string} resultType   `PBI_ResultType` annotation of an expression
 * @property {number} bodyStart    first body line in the script (-1 when inline)
 * @property {number} bodyEnd      last body line in the script
 */

const CODE_MAX = 20000;
const STEP_CODE_MAX = 2000;

function dedentLines(ls) {
  let min = Infinity;
  for (const l of ls) if (!isBlank(l)) min = Math.min(min, leadingWhitespace(l).length);
  if (!isFinite(min)) min = 0;
  return ls.map((l) => (isBlank(l) ? '' : l.slice(min)));
}

/**
 * All Power Query queries of a parse result with their steps.
 * @param {import('./parser.js').ParseResult} parsed
 * @returns {MQuery[]}
 */
export function collectQueries(parsed) {
  const out = [];
  for (const r of parsed.mQueries || []) {
    /** @type {MQuery} */
    const obj = r.kind === 'expression' ? parsed.objects.find((o) => o.key === r.descKey) : null;
    const q = {
      key: r.key, kind: r.kind, name: r.name, table: r.table, descKey: r.descKey, editable: r.editable, code: '', steps: [], error: '',
      inline: r.inline || '', queryGroup: (obj && obj.queryGroup) || '', resultType: (obj && obj.resultType) || '',
      bodyStart: r.bodyStart, bodyEnd: r.bodyEnd,
    };
    if (r.bodyStart >= 0) {
      const body = parsed.lines.slice(r.bodyStart, r.bodyEnd + 1);
      const code = dedentLines(body).join('\n');
      q.code = code.length > CODE_MAX ? code.slice(0, CODE_MAX) + '\n…' : code;
      const found = findSteps(body);
      q.error = found.error;
      const commentLines = found.steps.commentLines || new Set();
      let floor = 0;
      found.steps.forEach((s, i) => {
        const desc = readStepDescription(body, s.line, floor, commentLines);
        const stepCode = dedentLines(body.slice(s.line, s.endLine + 1)).join('\n');
        q.steps.push({
          key: 'step|' + r.key + '|' + s.raw,
          name: s.name,
          index: i + 1,
          line: r.bodyStart + s.line,
          descStart: r.bodyStart + desc.descStart,
          indent: leadingWhitespace(body[s.line]),
          originalDesc: desc.text,
          commentable: s.commentable && r.editable,
          code: stepCode.length > STEP_CODE_MAX ? stepCode.slice(0, STEP_CODE_MAX) + '…' : stepCode,
        });
        floor = s.endLine + 1;
      });
    }
    out.push(q);
  }
  return out;
}

/**
 * The query's M code as it will be after the current step-description edits
 * (same rules as the writer), dedented for display.
 * @param {string[]} lines script lines (ParseResult.lines)
 * @param {MQuery} q
 * @param {(step:MStep)=>string|null} changedDesc normalised new description, or null when unchanged
 */
export function queryCodeWithDescriptions(lines, q, changedDesc) {
  if (q.bodyStart < 0) return q.code;
  const body = lines.slice(q.bodyStart, q.bodyEnd + 1);
  for (const st of [...q.steps].reverse()) {
    if (!st.commentable) continue;
    const desc = changedDesc(st);
    if (desc === null) continue;
    body.splice(st.descStart - q.bodyStart, st.line - st.descStart, ...stepCommentLines(st.indent, desc));
  }
  const code = dedentLines(body).join('\n');
  return code.length > CODE_MAX ? code.slice(0, CODE_MAX) + '\n…' : code;
}

/** Comment lines for a step description. */
export function stepCommentLines(indent, desc) {
  if (desc === '') return [];
  return desc.split('\n').map((l) => (l === '' ? indent + '//' : indent + '// ' + l));
}
