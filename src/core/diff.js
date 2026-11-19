// Line diff for the output preview. Myers O(ND) after trimming the common
// prefix/suffix, so a 100k-line model with a few description edits is cheap.

/**
 * @typedef {{type:'eq'|'del'|'add', a:number, b:number, text:string}} DiffOp
 *   a/b = 0-based line index in old/new (-1 when not applicable)
 */

/**
 * @param {string[]} a old lines
 * @param {string[]} b new lines
 * @param {number=} maxD give up beyond this edit distance (fallback: replace block)
 * @returns {DiffOp[]}
 */
export function lineDiff(a, b, maxD = 3000) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  /** @type {DiffOp[]} */
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', a: i, b: i, text: a[i] });
  const mid = myers(a, start, endA, b, start, endB, maxD);
  for (const op of mid) ops.push(op);
  for (let i = endA, j = endB; i < a.length; i++, j++) ops.push({ type: 'eq', a: i, b: j, text: a[i] });
  return ops;
}

function myers(a, a0, a1, b, b0, b1, maxD) {
  const N = a1 - a0;
  const M = b1 - b0;
  if (N === 0 && M === 0) return [];
  const replaceAll = () => {
    const out = [];
    for (let i = a0; i < a1; i++) out.push({ type: 'del', a: i, b: -1, text: a[i] });
    for (let j = b0; j < b1; j++) out.push({ type: 'add', a: -1, b: j, text: b[j] });
    return out;
  };
  if (N === 0 || M === 0) return replaceAll();
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push({ lo: off - d - 1, arr: v.slice(off - d - 1, off + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return replaceAll();

  // Backtrack.
  const out = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    const t = trace[d];
    const at = (kk) => t.arr[off + kk - t.lo];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      out.push({ type: 'eq', a: a0 + x, b: b0 + y, text: a[a0 + x] });
    }
    if (x === prevX) {
      y--;
      out.push({ type: 'add', a: -1, b: b0 + y, text: b[b0 + y] });
    } else {
      x--;
      out.push({ type: 'del', a: a0 + x, b: -1, text: a[a0 + x] });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    out.push({ type: 'eq', a: a0 + x, b: b0 + y, text: a[a0 + x] });
  }
  return out.reverse();
}

/**
 * Group diff ops into hunks with `context` lines around each change.
 * @param {DiffOp[]} ops
 * @param {number=} context
 * @returns {{ops:DiffOp[], aStart:number, bStart:number}[]}
 */
export function toHunks(ops, context = 2) {
  const changed = [];
  ops.forEach((op, i) => {
    if (op.type !== 'eq') changed.push(i);
  });
  const hunks = [];
  let i = 0;
  while (i < changed.length) {
    let from = Math.max(0, changed[i] - context);
    let to = Math.min(ops.length - 1, changed[i] + context);
    let j = i + 1;
    while (j < changed.length && changed[j] - context <= to + 1) {
      to = Math.min(ops.length - 1, changed[j] + context);
      j++;
    }
    const slice = ops.slice(from, to + 1);
    let aStart = -1;
    let bStart = -1;
    for (const op of slice) {
      if (aStart < 0 && op.a >= 0) aStart = op.a;
      if (bStart < 0 && op.b >= 0) bStart = op.b;
    }
    hunks.push({ ops: slice, aStart, bStart });
    i = j;
  }
  return hunks;
}

/** Count added / removed lines. */
export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  return { added, removed };
}
