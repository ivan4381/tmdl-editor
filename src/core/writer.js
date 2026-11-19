// Writer (plan §7.2): only inserts / replaces / removes `///` description lines
// of recognised objects. Every other byte is copied from the original lines.

import { joinText } from './text.js';

/**
 * Normalise description text the way it will be written.
 * CRLF → LF, trailing spaces trimmed per line, leading/trailing blank lines removed.
 * @param {string} text
 */
export function normalizeDescription(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Build the description lines for an object.
 * @param {string} indent
 * @param {string} desc normalised description
 */
export function descriptionLines(indent, desc) {
  if (desc === '') return [];
  return desc.split('\n').map((l) => (l === '' ? indent + '///' : indent + '/// ' + l));
}

/**
 * True when an edit would change the bytes for this object.
 * @param {{originalDesc:string}} obj
 * @param {string} edit
 */
export function isChanged(obj, edit) {
  return normalizeDescription(edit) !== normalizeDescription(obj.originalDesc);
}

/**
 * @param {import('./parser.js').ParseResult} parsed
 * @param {Map<string,string>} edits key → new description ('' removes)
 * @returns {string}
 */
export function applyDescriptions(parsed, edits) {
  // Replacement per object, keyed by its declaration line. Description ranges
  // of different objects never overlap, so a single forward pass is enough
  // (equivalent to splicing bottom-up by declLine, plan §7.2, but O(n)).
  /** @type {Map<number, {descStart:number, lines:string[]}>} */
  const replacements = new Map();
  for (const obj of parsed.objects) {
    if (!obj.editable || !edits.has(obj.key)) continue;
    const edit = /** @type {string} */ (edits.get(obj.key));
    if (!isChanged(obj, edit)) continue;
    replacements.set(obj.declLine, { descStart: obj.descStart, lines: descriptionLines(obj.indent, normalizeDescription(edit)) });
  }
  if (replacements.size === 0) return joinText(parsed.lines, parsed);

  const src = parsed.lines;
  const skip = new Uint8Array(src.length);
  const out = [];
  for (const [declLine, r] of replacements) skip.fill(1, r.descStart, declLine);
  for (let i = 0; i < src.length; i++) {
    const r = replacements.get(i);
    if (r) for (const l of r.lines) out.push(l);
    if (!skip[i]) out.push(src[i]);
  }
  return joinText(out, parsed);
}
