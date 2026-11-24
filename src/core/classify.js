// Sidebar grouping by naming convention and model metadata. Pure functions.

/** Groups of the "Tabel, kolom & measure" sidebar, in display order. */
export const TABLE_GROUPS = [
  ['special', 'Special Table'],
  ['fact', 'Fact Table'],
  ['dim', 'Dimension Table'],
  ['other', 'Lainnya'],
];

/** Groups of the Power Query sidebar, in display order. */
export const QUERY_GROUPS = [
  ['special', 'Special Table'],
  ['fact', 'Fact Table'],
  ['dim', 'Dimension Table'],
  ['staging', 'Staging'],
  ['other', 'Lainnya'],
  ['fnparam', 'Fungsi & Parameter'],
];

/**
 * True when `name` starts with `word` (case-insensitive) used as a prefix, e.g. Dim:
 * DimCustomer, dimCustomer, Dim_Customer, Dim Customer, DIM_CUSTOMER, DIMCustomer → yes;
 * Dimonitor, Dimension, DIMONITOR → no. The character after the prefix must not be a
 * lower-case letter; after an all-caps prefix it must be a non-letter, or an upper-case
 * letter followed by a lower-case one.
 * @param {string} name
 * @param {string} word lower-case prefix
 */
export function prefixMatch(name, word) {
  const n = String(name || '').trim();
  const p = n.slice(0, word.length);
  if (p.toLowerCase() !== word) return false;
  const rest = n.slice(word.length);
  if (rest === '') return true;
  const c = rest[0];
  if (!/[A-Za-z]/.test(c)) return true;
  const allCaps = p === p.toUpperCase() && /[A-Z]/.test(p) && word.length > 1;
  if (allCaps) return /[A-Z]/.test(c) && /[a-z]/.test(rest[1] || '');
  return /[A-Z]/.test(c);
}

/** Lower-case name without leading symbols and without separators. */
function squash(name) {
  return String(name || '').trim().replace(/^[^A-Za-z0-9]+/, '').toLowerCase().replace(/[\s_\-.]+/g, '');
}

/** Calendar / date table by name (incl. Power BI auto date tables). */
export function isCalendarName(name) {
  if (/^(LocalDateTable|DateTableTemplate)_/i.test(String(name || '').trim())) return true;
  return /^(dim|tbl|tabel|table|master)?(date|dates|calendar|calendars|calender|kalender|tanggal|datetime)(table|tabel|tbl|dim)?$/.test(squash(name));
}

/** Table that stores measures, by name. */
export function isMeasureTableName(name) {
  const n = squash(name);
  return /^(key|all|my|base|main)?measures?(table|tabel|tbl|group|grp|folder)?$/.test(n)
    || /^(tbl|table|tabel)measures?$/.test(n)
    || /measures$/.test(n);
}

/**
 * @param {{name:string, dataCategory?:string, columns?:{name:string, isHidden?:boolean}[], measureCount?:number}} t
 * @returns {{group:'special'|'fact'|'dim'|'other', reason:string}}
 */
export function classifyTable(t) {
  const columns = t.columns || [];
  const measures = t.measureCount || 0;
  if (isCalendarName(t.name) || String(t.dataCategory || '').toLowerCase() === 'time') return { group: 'special', reason: 'kalender' };
  if (isMeasureTableName(t.name)) return { group: 'special', reason: 'tabel measure' };
  // Only measures, no real data columns (none, or a single helper column).
  const helperOnly = columns.length === 0
    || (columns.length === 1 && (columns[0].isHidden || /^(column1|value|dummy|kolom1|blank|helper)$/i.test(columns[0].name)));
  if (measures > 0 && helperOnly) return { group: 'special', reason: 'tabel measure' };
  if (prefixMatch(t.name, 'fact')) return { group: 'fact', reason: '' };
  if (prefixMatch(t.name, 'dim')) return { group: 'dim', reason: '' };
  return { group: 'other', reason: '' };
}

/** Parameter query: Power BI writes `meta [IsParameterQuery = true, …]`. */
export function isParameterCode(code) {
  return /\bIsParameterQuery\s*=\s*true\b/i.test(String(code || ''));
}

/** Function query: fn/fx prefix, PBI_ResultType = Function, or code that is a function literal. */
export function isFunctionQuery(name, resultType, code) {
  if (prefixMatch(name, 'fn') || prefixMatch(name, 'fx')) return true;
  if (String(resultType || '').toLowerCase() === 'function') return true;
  const c = String(code || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
  return /^\([^()]*\)\s*(as\s+[A-Za-z_.]+(\s+nullable)?\s*)?=>/.test(c);
}

/**
 * @param {{kind:'partition'|'expression', name:string, table:string, code?:string, inline?:string, queryGroup?:string, resultType?:string}} q
 * @param {Parameters<typeof classifyTable>[0]=} table info of the owning table (partitions)
 * @returns {{group:string, role:'function'|'parameter'|'', loaded:boolean}}
 */
export function classifyQuery(q, table) {
  if (q.kind === 'partition') {
    const t = table || { name: q.table };
    return { group: classifyTable(t).group, role: '', loaded: true };
  }
  const code = q.inline || q.code || '';
  if (isParameterCode(code)) return { group: 'fnparam', role: 'parameter', loaded: false };
  if (isFunctionQuery(q.name, q.resultType, code)) return { group: 'fnparam', role: 'function', loaded: false };
  if (isCalendarName(q.name) || isMeasureTableName(q.name)) return { group: 'special', role: '', loaded: false };
  if (prefixMatch(q.name, 'fact')) return { group: 'fact', role: '', loaded: false };
  if (prefixMatch(q.name, 'dim')) return { group: 'dim', role: '', loaded: false };
  if (prefixMatch(q.name, 'staging') || prefixMatch(q.name, 'stg') || /staging/i.test(q.queryGroup || '')) return { group: 'staging', role: '', loaded: false };
  return { group: 'other', role: '', loaded: false };
}

/**
 * Classification input for a table group of the editor (see items.js TableGroup).
 * @param {{name:string, items:{type:string, name:string, isHidden?:boolean, dataCategory?:string}[]}} g
 */
export function tableInfo(g) {
  const t = g.items.find((i) => i.type === 'table');
  return {
    name: g.name,
    dataCategory: t ? t.dataCategory : undefined,
    columns: g.items.filter((i) => i.type === 'column'),
    measureCount: g.items.filter((i) => i.type === 'measure').length,
  };
}
