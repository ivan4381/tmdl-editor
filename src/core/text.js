// Text helpers: BOM, EOL, line splitting and indentation measurement.
// Pure functions, no DOM.

export const BOM = '﻿';

/**
 * @param {string} text
 * @returns {'\r\n'|'\n'}
 */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Split raw text into the pieces needed for an exact round trip.
 * @param {string} raw
 * @returns {{lines:string[], eol:'\r\n'|'\n', hasBom:boolean, trailingNewline:boolean, mixedEol:boolean}}
 */
export function splitText(raw) {
  let text = raw;
  const hasBom = text.startsWith(BOM);
  if (hasBom) text = text.slice(1);
  const eol = detectEol(text);
  const trailingNewline = text.endsWith(eol);
  if (trailingNewline) text = text.slice(0, text.length - eol.length);
  const lines = text === '' && !trailingNewline ? [] : text.split(eol);
  // Mixed EOL: a CRLF file with a lone LF (or an LF file with a lone CR) inside.
  const mixedEol = eol === '\r\n'
    ? lines.some((l) => l.includes('\n') || l.includes('\r'))
    : lines.some((l) => l.includes('\r'));
  return { lines, eol, hasBom, trailingNewline, mixedEol };
}

/**
 * Inverse of splitText.
 * @param {string[]} lines
 * @param {{eol:string, hasBom:boolean, trailingNewline:boolean}} meta
 */
export function joinText(lines, meta) {
  let out = lines.join(meta.eol);
  if (meta.trailingNewline) out += meta.eol;
  if (meta.hasBom) out = BOM + out;
  return out;
}

/** Leading whitespace (tabs/spaces) of a line. */
export function leadingWhitespace(line) {
  let i = 0;
  while (i < line.length && (line[i] === '\t' || line[i] === ' ')) i++;
  return line.slice(0, i);
}

/** True for lines that are empty or whitespace only. */
export function isBlank(line) {
  return line.trim() === '';
}

/**
 * Detect the indentation unit from the first indented, non-blank line.
 * Tabs → 'tab'. Spaces → width of that first indentation (fallback 4).
 * @param {string[]} lines
 * @returns {{kind:'tab'|'space', width:number}}
 */
export function measureIndent(lines) {
  for (const line of lines) {
    if (isBlank(line)) continue;
    const ws = leadingWhitespace(line);
    if (ws === '') continue;
    if (ws[0] === '\t') return { kind: 'tab', width: 1 };
    return { kind: 'space', width: ws.length };
  }
  return { kind: 'tab', width: 1 };
}

/**
 * Indentation depth in units. A tab is always one level; spaces count
 * `width` per level (4 when the file is tab-indented).
 * @param {string} ws leading whitespace
 * @param {{kind:'tab'|'space', width:number}} unit
 */
export function indentDepth(ws, unit) {
  const spaceWidth = unit.kind === 'space' ? unit.width : 4;
  let tabs = 0;
  let spaces = 0;
  for (const ch of ws) {
    if (ch === '\t') tabs++;
    else spaces++;
  }
  return tabs + Math.floor(spaces / spaceWidth);
}

/** Truncate a string for display. */
export function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max) + '… (+' + (s.length - max) + ' karakter)';
}

/**
 * Small, fast, non-cryptographic hash (cyrb53) used to match drafts to input.
 * @param {string} str
 * @returns {string}
 */
export function hashText(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
