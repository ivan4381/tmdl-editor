// Pure helpers for bulk fill, templates and find/replace on description text.

const TYPE_LABEL = { table: 'tabel', column: 'kolom', measure: 'measure' };

/**
 * Expand {name}, {table} and {type} placeholders. Unknown placeholders stay as-is.
 * @param {string} template
 * @param {{name:string, table:string, type:string}} item
 */
export function applyTemplate(template, item) {
  return template.replace(/\{(name|table|type)\}/gi, (_, k) => {
    const key = k.toLowerCase();
    if (key === 'name') return item.name;
    if (key === 'table') return item.table;
    return TYPE_LABEL[item.type] || item.type;
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every occurrence of `find` (literal) in `text`.
 * @param {string} text
 * @param {string} find
 * @param {string} replacement
 * @param {boolean} caseSensitive
 * @returns {{text:string, count:number}}
 */
export function replaceAllLiteral(text, find, replacement, caseSensitive) {
  if (!find) return { text, count: 0 };
  const re = new RegExp(escapeRegExp(find), caseSensitive ? 'g' : 'gi');
  let count = 0;
  const out = text.replace(re, () => {
    count++;
    return replacement;
  });
  return { text: out, count };
}
