// Validator (plan §7.3): proves that only description lines of recognised
// objects (`///`) and step-description comments (`//` above a recognised
// Power Query step) differ between the original and the output.

import { parseTmdl } from './parser.js';
import { collectQueries } from './mquery.js';

/**
 * @typedef {Object} ValidationIssue
 * @property {number} line      1-based line in the output (or original when not applicable)
 * @property {string} message
 * @property {string=} expected
 * @property {string=} actual
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {ValidationIssue[]} errors
 */

const MAX_ERRORS = 20;

/**
 * Lines that are NOT part of a recognised description range, with their line numbers.
 * @param {import('./parser.js').ParseResult} parsed
 */
export function skeleton(parsed, queries = collectQueries(parsed)) {
  const skip = new Uint8Array(parsed.lines.length);
  for (const o of parsed.objects) {
    for (let j = o.descStart; j < o.declLine; j++) skip[j] = 1;
  }
  for (const q of queries) {
    for (const st of q.steps) {
      if (!st.commentable) continue;
      for (let j = st.descStart; j < st.line; j++) skip[j] = 1;
    }
  }
  const out = [];
  for (let i = 0; i < parsed.lines.length; i++) {
    if (!skip[i]) out.push({ line: i + 1, text: parsed.lines[i] });
  }
  return out;
}

/**
 * @param {string} original
 * @param {string} output
 * @returns {ValidationResult}
 */
export function validateRoundTrip(original, output) {
  /** @type {ValidationIssue[]} */
  const errors = [];
  const push = (e) => {
    if (errors.length < MAX_ERRORS) errors.push(e);
  };
  const a = parseTmdl(original);
  const b = parseTmdl(output);

  if (a.eol !== b.eol) push({ line: 0, message: 'Line ending berubah.', expected: JSON.stringify(a.eol), actual: JSON.stringify(b.eol) });
  if (a.hasBom !== b.hasBom) push({ line: 0, message: 'BOM berubah.', expected: String(a.hasBom), actual: String(b.hasBom) });
  if (a.trailingNewline !== b.trailingNewline) {
    push({ line: 0, message: 'Newline di akhir file berubah.', expected: String(a.trailingNewline), actual: String(b.trailingNewline) });
  }

  // Same objects, same order.
  const ka = a.objects.map((o) => o.key);
  const kb = b.objects.map((o) => o.key);
  if (ka.length !== kb.length) {
    push({ line: 0, message: 'Jumlah objek berubah.', expected: String(ka.length), actual: String(kb.length) });
  }
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    if (ka[i] !== kb[i]) {
      push({ line: b.objects[i].declLine + 1, message: 'Urutan atau identitas objek berubah.', expected: ka[i], actual: kb[i] });
      break;
    }
  }

  // Same Power Query queries and steps, same order.
  const qa = collectQueries(a);
  const qb = collectQueries(b);
  const stepsOf = (qs) => qs.flatMap((q) => [q.key + (q.error ? '!' : ''), ...q.steps.map((st) => st.key + (st.commentable ? '' : '#'))]);
  const pa = stepsOf(qa);
  const pb = stepsOf(qb);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) {
      push({ line: 0, message: 'Struktur query/step Power Query berubah.', expected: pa[i] ?? '(tidak ada)', actual: pb[i] ?? '(tidak ada)' });
      break;
    }
  }

  // Skeleton must be identical line by line, whitespace included.
  const sa = skeleton(a, qa);
  const sb = skeleton(b, qb);
  const n = Math.max(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const x = sa[i];
    const y = sb[i];
    if (!x || !y || x.text !== y.text) {
      push({
        line: y ? y.line : x ? x.line : 0,
        message: 'Baris di luar deskripsi berubah.',
        expected: x ? x.text : '(tidak ada)',
        actual: y ? y.text : '(tidak ada)',
      });
      if (errors.length >= MAX_ERRORS) break;
      // One mismatch usually shifts everything after it; stop after a few.
      if (errors.filter((e) => e.message.startsWith('Baris di luar')).length >= 5) break;
    }
  }

  // Description lines must not carry stray CR/LF.
  for (const o of b.objects) {
    for (let j = o.descStart; j < o.declLine; j++) {
      if (/[\r\n]/.test(b.lines[j])) push({ line: j + 1, message: 'Baris deskripsi mengandung CR/LF di tengahnya.', actual: JSON.stringify(b.lines[j]) });
    }
  }

  // Descriptions of non-editable objects (ref table) must not change.
  if (ka.length === kb.length) {
    for (let i = 0; i < a.objects.length; i++) {
      const oa = a.objects[i];
      const ob = b.objects[i];
      if (!oa.editable && oa.key === ob.key && oa.originalDesc !== ob.originalDesc) {
        push({ line: ob.declLine + 1, message: 'Deskripsi objek non-editable (ref) berubah.', expected: oa.originalDesc, actual: ob.originalDesc });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
