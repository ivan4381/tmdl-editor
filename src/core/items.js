// Editor view model derived from a ParseResult: one item per key (partial
// declarations merged), grouped per table in order of appearance.

import { normalizeDescription } from './writer.js';

/**
 * @typedef {Object} EditorItem
 * @property {string} key
 * @property {'table'|'column'|'measure'} type
 * @property {string} table
 * @property {string} name
 * @property {string=} dataType
 * @property {boolean} isHidden
 * @property {string=} expression
 * @property {boolean} editable
 * @property {string} originalDesc
 * @property {number} occurrences
 * @property {number} line  1-based line of the first declaration
 */

/**
 * @typedef {Object} TableGroup
 * @property {string} key    lowercased table name
 * @property {string} name
 * @property {boolean} editable  false when the table itself is only a `ref`
 * @property {EditorItem[]} items  table item first, then columns/measures
 */

/**
 * @param {import('./parser.js').ParseResult} parsed
 * @returns {{items:EditorItem[], byKey:Map<string,EditorItem>, tables:TableGroup[]}}
 */
export function buildItems(parsed) {
  /** @type {Map<string, EditorItem>} */
  const byKey = new Map();
  /** @type {EditorItem[]} */
  const items = [];
  /** @type {Map<string, TableGroup>} */
  const groups = new Map();
  for (const o of parsed.objects) {
    if (o.type === 'expression') continue; // Power Query expressions live in the M view
    let it = byKey.get(o.key);
    if (!it) {
      it = {
        key: o.key,
        type: o.type,
        table: o.table,
        name: o.name,
        dataType: o.dataType,
        isHidden: o.isHidden,
        expression: o.expression,
        editable: o.editable,
        originalDesc: o.originalDesc,
        occurrences: 1,
        line: o.declLine + 1,
      };
      byKey.set(o.key, it);
      items.push(it);
      const gk = o.table.toLowerCase();
      let g = groups.get(gk);
      if (!g) {
        g = { key: gk, name: o.table, editable: false, items: [] };
        groups.set(gk, g);
      }
      if (o.type === 'table') g.items.unshift(it);
      else g.items.push(it);
    } else {
      it.occurrences++;
      if (o.editable && !it.editable) {
        it.editable = true;
        it.originalDesc = o.originalDesc;
      }
      if (!it.dataType && o.dataType) it.dataType = o.dataType;
      if (!it.expression && o.expression) it.expression = o.expression;
      it.isHidden = it.isHidden || o.isHidden;
    }
  }
  for (const g of groups.values()) {
    const t = g.items.find((i) => i.type === 'table');
    g.editable = !!t && t.editable;
  }
  return { items, byKey, tables: [...groups.values()] };
}

/**
 * @param {EditorItem} item
 * @param {Map<string,string>} edits
 */
export function currentDescription(item, edits) {
  return edits.has(item.key) ? /** @type {string} */ (edits.get(item.key)) : item.originalDesc;
}

/**
 * @param {EditorItem} item
 * @param {Map<string,string>} edits
 */
export function itemStatus(item, edits) {
  const cur = normalizeDescription(currentDescription(item, edits));
  return {
    filled: cur !== '',
    changed: item.editable && cur !== normalizeDescription(item.originalDesc),
  };
}

/**
 * Progress over editable items.
 * @param {EditorItem[]} items
 * @param {Map<string,string>} edits
 */
export function progress(items, edits) {
  let total = 0;
  let filled = 0;
  let changed = 0;
  for (const it of items) {
    if (!it.editable) continue;
    total++;
    const s = itemStatus(it, edits);
    if (s.filled) filled++;
    if (s.changed) changed++;
  }
  return { total, filled, changed };
}

/** Summary counts for the input step. */
export function summarize(parsed) {
  const c = { table: 0, column: 0, measure: 0, expression: 0, withDesc: 0, mQueries: (parsed.mQueries || []).length };
  for (const o of parsed.objects) {
    c[o.type]++;
    if (o.type !== 'expression' && o.originalDesc !== '') c.withDesc++;
  }
  return c;
}
