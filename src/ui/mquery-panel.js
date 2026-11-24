// Edit step, "Power Query (M)" mode: query descriptions and per-step descriptions
// (`//` comments above each step, shown as step descriptions in Power Query).

import { normalizeDescription } from '../core/writer.js';
import { truncate } from '../core/text.js';
import { lineDiff } from '../core/diff.js';
import { pqFileName } from '../core/refactor.js';
import { tokenizeM, queryCodeWithDescriptions } from '../core/mquery.js';
import { QUERY_GROUPS, classifyQuery, tableInfo } from '../core/classify.js';
import { sideGroup } from './side-groups.js';
import { h, clear, autoGrow, fmt, toast, copyText, downloadText } from './dom.js';

const LINE_MAX = 300;

/**
 * M code as DOM nodes with comments wrapped in <span class="m-comment">.
 * Uses the M tokenizer, so `//` inside strings is not a comment. Text that cannot be
 * tokenised (e.g. a line cut out of a multi-line string) falls back to whole-line
 * `//` comments only.
 * @param {string} code
 * @returns {(Node|string)[]}
 */
function mCode(code) {
  let tokens = null;
  try {
    tokens = tokenizeM(code);
  } catch {
    tokens = null;
  }
  if (!tokens) {
    return code.split('\n').flatMap((line, i) => {
      const parts = /^\s*\/\//.test(line) ? [h('span', { class: 'm-comment', text: line })] : [line];
      return i ? ['\n', ...parts] : parts;
    });
  }
  const out = [];
  let buf = '';
  for (const t of tokens) {
    if (t.t === 'line' || t.t === 'block') {
      if (buf) out.push(buf);
      buf = '';
      out.push(h('span', { class: 'm-comment', text: t.v }));
    } else buf += t.v;
  }
  if (buf) out.push(buf);
  return out;
}

/** Replace the content of a <pre> with highlighted M code. */
function setCode(el, code) {
  clear(el);
  el.append(...mCode(code));
  return el;
}
const CODE_PREVIEW_LINES = 4;

/**
 * @param {any} app
 * @param {HTMLElement} root
 */
export function initMPanel(app, root) {
  const ui = {
    /** @type {string|null} */
    current: null,
    filter: 'all',
    /** @type {Map<string, HTMLElement>} */
    rows: new Map(),
    /** @type {Map<string, HTMLElement>} */
    sideItems: new Map(),
    /** query key → 'desc' | 'refactor' */
    subtab: new Map(),
    /** collapsed sidebar categories ('partition' | 'expression'), remembered in prefs */
    collapsed: new Set(Array.isArray(app.prefs.mqCollapsed) ? app.prefs.mqCollapsed : []),
    /** "Lihat kode M lengkap" open (kept while switching queries) */
    codeOpen: false,
    /** query key → 'code' | 'alt' | 'diff' (view inside "Hasil refactor") */
    rview: new Map(),
  };

  const sideList = h('div', { class: 'side-list', role: 'listbox', 'aria-label': 'Query' });
  const filterSel = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Filter query', id: 'mq-filter' },
    h('option', { value: 'all', text: 'Semua query' }),
    h('option', { value: 'todo', text: 'Belum lengkap' })));
  const main = h('section', { class: 'editor' });
  root.append(h('div', { class: 'edit-layout' },
    h('aside', { class: 'sidebar' }, h('div', { class: 'side-head' }, h('strong', { text: 'Query' }), filterSel), sideList),
    main));

  const doc = () => app.doc();
  /** classification of a query (group, function/parameter role, loaded to the model) */
  const classOf = (q) => {
    const d = doc();
    const g = q.kind === 'partition' ? d.tables.find((t) => t.key === q.table.toLowerCase()) : null;
    return classifyQuery(q, g ? tableInfo(g) : undefined);
  };
  const queryOf = (key) => (doc() ? doc().queries.find((q) => q.key === key) || null : null);
  const label = (q) => (q.kind === 'partition' ? q.table + (q.name.toLowerCase() !== q.table.toLowerCase() ? ' › ' + q.name : '') : q.name);
  const isEmptyKey = (key) => {
    const e = app.entry(key);
    return !e || normalizeDescription(app.desc(e)) === '';
  };

  /** filled / total over editable fields of a query (query description + describable steps). */
  function stats(q) {
    const keys = [];
    const qd = app.entry(q.descKey);
    if (qd && qd.editable) keys.push(q.descKey);
    for (const st of q.steps) if (st.commentable) keys.push(st.key);
    const filled = keys.filter((k) => !isEmptyKey(k)).length;
    return { filled, total: keys.length };
  }

  // ---------- sidebar ----------
  function renderSidebar() {
    // Rebuilding the list would reset the sidebar's scroll position: keep it.
    const scroller = /** @type {HTMLElement|null} */ (sideList.closest('.sidebar'));
    const keepTop = scroller ? scroller.scrollTop : 0;
    clear(sideList);
    ui.sideItems.clear();
    const d = doc();
    if (!d) return;
    // Group by naming convention / metadata: Special, Fact, Dimension, Staging, Lainnya, Fungsi & Parameter.
    const byGroup = new Map(QUERY_GROUPS.map(([id]) => [id, []]));
    for (const q of d.queries) {
      if (ui.filter === 'todo') {
        const st = stats(q);
        if (st.filled >= st.total) continue;
      }
      byGroup.get(classOf(q).group).push(q);
    }
    for (const [gid, title] of QUERY_GROUPS) {
      const qs = byGroup.get(gid);
      if (!qs.length) continue;
      const g = sideGroup({
        id: gid, title, count: qs.length, open: !ui.collapsed.has(gid), domId: 'mq-group-' + gid,
        onToggle: (open) => {
          if (open) ui.collapsed.delete(gid);
          else ui.collapsed.add(gid);
          app.savePrefs({ mqCollapsed: [...ui.collapsed] });
        },
      });
      sideList.append(g.head, g.items);
      for (const q of qs) {
        const c = classOf(q);
        const notLoaded = !c.loaded && !c.role;
        const el = h('button', {
          type: 'button', class: 'side-item' + (notLoaded ? ' not-loaded' : ''), role: 'option', dataset: { query: q.key },
          title: label(q) + (notLoaded ? ' · tidak dimuat ke model' : ''),
        },
          h('span', { class: 'side-name' }, label(q),
            c.role ? h('span', { class: 'tag tiny', text: c.role === 'function' ? 'fungsi' : 'parameter' }) : null,
            q.error ? h('span', { class: 'tag tiny warn', text: 'M tak dikenali' }) : null,
            d.refactors && d.refactors.has(q.key) ? h('span', { class: 'rf-badge', title: 'Sudah ada hasil refactor', text: ' 🛠' }) : null),
          h('span', { class: 'side-count' }),
          h('span', { class: 'side-bar' }, h('span')));
        el.addEventListener('click', () => {
          ui.current = q.key;
          markActive(); // keep the sidebar list (and its scroll position) as it is
          renderMain();
        });
        ui.sideItems.set(q.key, el);
        updateSideItem(q);
        g.items.append(el);
      }
    }
    if (!sideList.childElementCount) {
      sideList.append(h('p', { class: 'muted small', text: ui.filter === 'todo' ? 'Semua query sudah lengkap.' : 'Tidak ada query Power Query di script ini.' }));
    }
    markActive();
    if (scroller) scroller.scrollTop = keepTop;
  }

  function updateSideItem(q) {
    const el = ui.sideItems.get(q.key);
    if (!el) return;
    const s = stats(q);
    el.querySelector('.side-count').textContent = `${s.filled}/${s.total}`;
    /** @type {HTMLElement} */ (el.querySelector('.side-bar > span')).style.width = (s.total ? (s.filled / s.total) * 100 : 100) + '%';
    el.classList.toggle('complete', s.total > 0 && s.filled === s.total);
  }

  function markActive() {
    for (const [k, el] of ui.sideItems) {
      el.classList.toggle('active', k === ui.current);
      el.setAttribute('aria-selected', String(k === ui.current));
    }
  }

  // ---------- main ----------
  function descField(key, opts) {
    const e = app.entry(key);
    const editable = !!e && e.editable;
    const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', {
      class: 'desc', rows: 1, spellcheck: true, dataset: { key }, disabled: !editable,
      'aria-label': opts.aria, placeholder: editable ? opts.placeholder : opts.disabledText,
    }));
    ta.value = e ? app.desc(e) : '';
    const aiBtn = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', class: 'icon-btn ai-suggest', title: 'Isi dengan saran AI', 'aria-label': 'Saran AI untuk ' + opts.aria, text: '✨', disabled: !editable,
    }));
    const resetBtn = h('button', { type: 'button', class: 'icon-btn reset', title: 'Kembalikan ke deskripsi asli', 'aria-label': 'Reset', text: '↺' });
    const meta = h('div', { class: 'desc-meta' },
      h('span', { class: 'ai-mark', title: 'Diisi dengan saran AI. Periksa sebelum dipakai.', text: '✨ saran AI' }),
      h('span', { class: 'changed-mark', text: 'diubah' }), resetBtn, aiBtn);
    ta.addEventListener('focus', () => {
      ta.dataset.before = ta.value;
    });
    ta.addEventListener('input', () => {
      autoGrow(ta);
      app.setDesc(key, ta.value);
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.isComposing) return;
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        ev.preventDefault();
        const all = [...main.querySelectorAll('textarea.desc:not([disabled])')];
        const next = all[all.indexOf(ta) + 1];
        if (next) {
          /** @type {HTMLTextAreaElement} */ (next).focus();
        } else ta.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ta.value = ta.dataset.before ?? ta.value;
        autoGrow(ta);
        app.setDesc(key, ta.value);
      }
    });
    resetBtn.addEventListener('click', () => {
      if (!e) return;
      ta.value = e.originalDesc;
      autoGrow(ta);
      app.setDesc(key, e.originalDesc);
      ta.focus();
    });
    aiBtn.addEventListener('click', () => opts.onAi(aiBtn));
    return { ta, meta };
  }

  function codePreview(code) {
    const lines = code.split('\n');
    const short = lines.slice(0, CODE_PREVIEW_LINES).map((l) => truncate(l, LINE_MAX)).join('\n');
    const full = lines.map((l) => truncate(l, LINE_MAX)).join('\n');
    const pre = setCode(h('pre', { class: 'expr' }), short);
    const out = [pre];
    if (lines.length > CODE_PREVIEW_LINES) {
      const btn = h('button', { type: 'button', class: 'link-btn', text: 'selengkapnya' });
      btn.addEventListener('click', () => {
        const open = pre.classList.toggle('expanded');
        setCode(pre, open ? full : short);
        btn.textContent = open ? 'ringkas' : 'selengkapnya';
      });
      out.push(btn);
    }
    return out;
  }

  function renderMain() {
    clear(main);
    ui.rows.clear();
    const d = doc();
    if (!d) return;
    if (!d.queries.length) {
      main.append(h('div', { class: 'empty-state' },
        h('p', { text: 'Script ini tidak berisi query Power Query (partition M atau expression).' }),
        h('p', { class: 'muted', text: 'Untuk mendeskripsikan step M, script seluruh model atau tabel lengkap (bukan hanya measure).' })));
      return;
    }
    let q = queryOf(ui.current);
    if (!q) {
      q = d.queries[0];
      ui.current = q.key;
      markActive();
    }
    const ai = app.ai;
    const aiReady = ai.isReady();
    const canRefactor = aiReady && q.code !== '' && q.editable;
    const refactorTitle = !aiReady ? 'Atur API key dan model AI di ⚙ AI terlebih dahulu'
      : q.code === '' ? 'Query satu baris tidak perlu di-refactor'
        : !q.editable ? 'Query ref tidak bisa di-refactor dari script parsial ini' : 'Tulis ulang kode M query ini dengan AI (hasil terpisah, tidak mengubah script)';
    const result = d.refactors && d.refactors.get(q.key);
    const startRefactor = () => ai.openRefactor(q, () => {
      ui.subtab.set(q.key, 'refactor');
      ui.rview.set(q.key, 'code');
      renderSidebar();
      renderMain();
    });
    const toolbar = h('div', { class: 'tools' },
      h('span', { class: 'muted', text: 'Komentar // di atas step = deskripsi step di Power Query.', title: 'Deskripsi step ditulis sebagai komentar // tepat di atas step dan tampil di Applied Steps Power Query.' }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small ai-btn', id: 'mq-ai-query', text: '✨ Isi query ini…', onclick: () => ai.openBulkM({ current: q }) }),
      h('button', { type: 'button', class: 'btn small ai-btn', id: 'mq-ai-all', text: '✨ Isi semua query…', onclick: () => ai.openBulkM() }),
      h('button', { type: 'button', class: 'btn small ai-btn', id: 'mq-refactor', text: '🛠 Refactor dengan AI', title: refactorTitle, disabled: !canRefactor, onclick: startRefactor }),
      h('button', { type: 'button', class: 'btn small', title: 'Pengaturan AI', text: '⚙ AI', onclick: () => ai.openSettings() }));
    const s = stats(q);
    const head = h('div', { class: 'view-head' },
      h('h2', { text: label(q) }),
      (() => {
        const c = classOf(q);
        const txt = c.loaded ? 'Dimuat ke model' : c.role === 'function' ? 'Fungsi' : c.role === 'parameter' ? 'Parameter' : 'Tidak dimuat ke model';
        return h('span', { class: 'type-badge ' + (c.loaded ? 'table' : c.role ? 'column' : 'measure'), text: txt });
      })(),
      h('span', { class: 'muted', id: 'mq-stats', text: `${fmt(q.steps.length)} step · ${fmt(s.filled)}/${fmt(s.total)} terisi` }));
    const sub = result ? (ui.subtab.get(q.key) || 'desc') : 'desc';
    const subtabs = h('div', { class: 'subtabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', class: 'subtab' + (sub === 'desc' ? ' active' : ''), id: 'mq-sub-desc', text: 'Deskripsi step',
        onclick: () => { ui.subtab.set(q.key, 'desc'); renderMain(); } }),
      h('button', { type: 'button', role: 'tab', class: 'subtab' + (sub === 'refactor' ? ' active' : ''), id: 'mq-sub-refactor', disabled: !result,
        title: result ? '' : 'Belum ada hasil refactor untuk query ini. Klik 🛠 Refactor dengan AI.', text: 'Hasil refactor 🛠',
        onclick: () => { ui.subtab.set(q.key, 'refactor'); renderMain(); } }));
    main.append(toolbar, head, subtabs);
    if (sub === 'refactor' && result) {
      renderRefactor(q, result, startRefactor);
      return;
    }
    if (q.error) {
      main.append(h('div', { class: 'banner warn' },
        h('strong', { text: 'Struktur M query ini tidak dikenali' }), ` (${q.error}). Deskripsi step tidak bisa ditambahkan; deskripsi query tetap bisa diisi.`));
    } else if (!q.steps.length && q.code === '') {
      main.append(h('p', { class: 'muted', text: 'Query satu baris (misalnya parameter) tidak punya step. Deskripsi query tetap bisa diisi.' }));
    } else if (!q.steps.length) {
      main.append(h('p', { class: 'muted', text: 'Query ini tidak memakai let … in, jadi tidak ada step yang bisa dideskripsikan.' }));
    }

    // Query description.
    const qf = descField(q.descKey, {
      aria: 'Deskripsi query ' + label(q),
      placeholder: 'Deskripsi query…',
      disabledText: 'ref: deskripsi query tidak bisa diubah dari script parsial ini',
      onAi: (btn) => ai.suggestM(q, { kind: 'query' }, btn),
    });
    const qCard = h('div', { class: 'card q-desc row', dataset: { key: q.descKey } },
      h('div', { class: 'q-desc-head' }, h('strong', { text: 'Deskripsi query' }),
        h('span', { class: 'muted small', text: q.kind === 'partition'
          ? ' · sama dengan deskripsi tabel (tampil di Data pane, tooltip, dan Query properties)'
          : ' · tampil di Query properties Power Query' })),
      qf.ta, qf.meta);
    main.append(qCard);
    ui.rows.set(q.descKey, qCard);

    if (q.code) {
      const details = h('details', { class: 'code-details', open: ui.codeOpen },
        h('summary', { text: 'Lihat kode M lengkap', title: 'Termasuk deskripsi step yang sedang diisi, persis seperti yang akan ditulis ke script' }),
        h('pre', { class: 'expr expanded code-full', id: 'mq-code-full' }));
      details.addEventListener('toggle', () => { ui.codeOpen = details.open; });
      main.append(details);
      refreshFullCode(q);
    }

    if (q.steps.length) {
      const tbody = h('tbody');
      for (const st of q.steps) {
        const f = descField(st.key, {
          aria: 'Deskripsi step ' + st.name,
          placeholder: 'Deskripsi step…',
          disabledText: st.commentable ? '' : 'Step ini berbagi baris dengan step lain, jadi tidak bisa diberi komentar',
          onAi: (btn) => ai.suggestM(q, { kind: 'step', step: st }, btn),
        });
        const row = h('tr', { class: 'row', dataset: { key: st.key } },
          h('td', { class: 'c-idx muted', text: String(st.index) }),
          h('td', { class: 'c-name' }, h('span', { class: 'obj-name', text: st.name })),
          h('td', { class: 'c-expr' }, codePreview(st.code)),
          h('td', { class: 'c-desc' }, f.ta, f.meta));
        tbody.append(row);
        ui.rows.set(st.key, row);
      }
      main.append(h('div', { class: 'grid-wrap' }, h('table', { class: 'grid mq-grid' },
        h('thead', null, h('tr', null,
          h('th', { class: 'c-idx', text: '#' }),
          h('th', { class: 'c-name', text: 'Step' }),
          h('th', { class: 'c-expr', text: 'Kode' }),
          h('th', { class: 'c-desc', text: 'Deskripsi step' }))),
        tbody)));
    }
    main.append(h('p', { class: 'kbd-hint muted' },
      h('kbd', { text: 'Enter' }), ' simpan & ke berikutnya · ', h('kbd', { text: 'Shift+Enter' }), ' baris baru · ', h('kbd', { text: 'Esc' }), ' batalkan perubahan'));
    for (const key of ui.rows.keys()) refreshRow(key);
    requestAnimationFrame(() => {
      for (const ta of main.querySelectorAll('textarea')) autoGrow(/** @type {HTMLTextAreaElement} */ (ta));
    });
  }

  // ---------- "Hasil refactor" sub-tab ----------
  function checkList(analysis) {
    return h('ul', { class: 'rf-checks' }, analysis.checks.map((c) => h('li', { class: c.ok ? 'ok' : 'bad' },
      h('span', { class: 'rf-icon', text: c.ok ? '✓' : '⚠' }), ' ', c.label, c.detail ? h('span', { class: 'muted', text: ' · ' + c.detail }) : null)));
  }

  function statLine(st) {
    const delta = (a, b) => (b === a ? '' : b > a ? ` (+${fmt(b - a)})` : ` (−${fmt(a - b)})`);
    return h('p', { class: 'rf-stats', id: 'rf-stats' },
      h('strong', { text: 'Baris kode: ' }), `${fmt(st.linesBefore)} → ${fmt(st.linesAfter)}${delta(st.linesBefore, st.linesAfter)}`,
      h('span', { class: 'muted', text: ' (tanpa komentar dan baris kosong)' }),
      ' · ', h('strong', { text: 'Step: ' }), `${fmt(st.stepsBefore)} → ${fmt(st.stepsAfter)}`);
  }

  /** Full M code of the current query including the current step descriptions. */
  function refreshFullCode(q) {
    const pre = main.querySelector('#mq-code-full');
    if (!pre) return;
    const code = queryCodeWithDescriptions(doc().parsed.lines, q, (st) => {
      const e = app.entry(st.key);
      if (!e) return null;
      const cur = normalizeDescription(app.desc(e));
      return cur === normalizeDescription(st.originalDesc) ? null : cur;
    });
    setCode(pre, code.split('\n').map((l) => truncate(l, LINE_MAX)).join('\n'));
  }

  function codeActions(q, code, suffix, rerun) {
    const crlf = code.replace(/\r\n?/g, '\n').split('\n').join('\r\n') + '\r\n';
    return h('div', { class: 'actions rf-actions' },
      h('button', { type: 'button', class: 'btn primary small', id: 'rf-copy' + suffix, text: 'Copy', onclick: async () => {
        const ok = await copyText(code);
        toast(ok ? 'Kode disalin. Tempel di Advanced Editor Power Query (ganti seluruh isi), lalu Done.' : 'Gagal menyalin. Pakai Download .pq.', ok ? 'ok' : 'error');
      } }),
      h('button', { type: 'button', class: 'btn small', id: 'rf-download' + suffix, text: 'Download .pq',
        onclick: () => downloadText(pqFileName(label(q), suffix ? '.alternatif' : '.refactor'), crlf) }),
      rerunButton(rerun));
  }

  function rerunButton(rerun) {
    return h('button', { type: 'button', class: 'btn small rf-rerun', id: 'rf-rerun', text: '🛠 Refactor ulang',
      title: 'Jalankan refactor lagi untuk query ini (menimpa hasil di atas)', disabled: !app.ai.isReady(), onclick: rerun });
  }

  /** Collapsible "Penjelasan perubahan" (closed by default; open state remembered). */
  function explanation(r) {
    if (!r.explanation) return null;
    const points = r.explanation.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
    const det = h('details', { class: 'rf-explain-box', id: 'rf-explain', open: !!app.prefs.rfExplainOpen },
      h('summary', null, h('strong', { text: 'Penjelasan perubahan' }), h('span', { class: 'muted', text: ` (${fmt(points.length)} poin)` })),
      h('ul', { class: 'rf-explain' }, points.map((t) => h('li', { text: t }))));
    det.addEventListener('toggle', () => app.savePrefs({ rfExplainOpen: det.open }));
    return det;
  }

  function diffView(original, changed) {
    const ops = lineDiff(original.split('\n'), changed.split('\n'));
    return h('div', { class: 'diff rf-diff' }, ops.map((op) => h('div', { class: 'dl ' + op.type },
      h('span', { class: 'ln', text: op.a >= 0 ? String(op.a + 1) : '' }),
      h('span', { class: 'ln', text: op.b >= 0 ? String(op.b + 1) : '' }),
      h('span', { class: 'sign', text: op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ' }),
      setCode(h('span', { class: 'code' }), truncate(op.text, 2000)))));
  }

  function renderRefactor(q, r, rerun) {
    const view = ui.rview.get(q.key) || 'code';
    const setView = (v) => { ui.rview.set(q.key, v); renderMain(); };
    const when = new Date(r.at).toLocaleString('id-ID');
    main.append(
      h('div', { class: 'banner warn' },
        h('strong', { text: 'Belum diuji. ' }),
        'Hasil ini tidak mengubah script TMDL. Tempel di Advanced Editor Power Query untuk query ini (ganti seluruh kode), lalu refresh dan bandingkan jumlah baris/kolom dengan hasil sebelumnya.'),
      h('p', { class: 'muted small' }, `Dibuat ${when} · ${r.model} · komentar ${r.lang === 'en' ? 'English' : 'Bahasa Indonesia'}`,
        r.masked ? ' · URL/server/path disensor saat dikirim dan sudah dikembalikan' : ''));
    const seg = h('div', { class: 'seg rf-seg', role: 'radiogroup' },
      h('button', { type: 'button', class: 'seg-btn' + (view === 'code' ? ' active' : ''), id: 'rf-view-code', text: 'Kode refactor', onclick: () => setView('code') }),
      r.alternative ? h('button', { type: 'button', class: 'seg-btn' + (view === 'alt' ? ' active' : ''), id: 'rf-view-alt', text: 'Alternatif', onclick: () => setView('alt') }) : null,
      h('button', { type: 'button', class: 'seg-btn' + (view === 'diff' ? ' active' : ''), id: 'rf-view-diff', text: 'Bandingkan asli', onclick: () => setView('diff') }));
    main.append(seg);
    const card = h('div', { class: 'card rf-card' });
    if (view === 'alt' && r.alternative) {
      card.append(statLine(r.altAnalysis.stats), checkList(r.altAnalysis), explanation(r) || '',
        setCode(h('pre', { class: 'rf-code', id: 'rf-code' }), r.alternative), codeActions(q, r.alternative, '-alt', rerun));
    } else if (view === 'diff') {
      const target = ui.rview.get(q.key + '|diff') === 'alt' && r.alternative ? 'alt' : 'code';
      const pick = /** @type {HTMLSelectElement} */ (h('select', { id: 'rf-diff-target' },
        h('option', { value: 'code', text: 'Kode asli vs hasil refactor' }),
        r.alternative ? h('option', { value: 'alt', text: 'Kode asli vs alternatif' }) : null));
      pick.value = target;
      pick.addEventListener('change', () => { ui.rview.set(q.key + '|diff', pick.value); renderMain(); });
      card.append(h('div', { class: 'row-inline' }, pick, h('span', { class: 'muted small', text: '− baris kode asli · + baris hasil' })),
        diffView(q.code, target === 'alt' ? r.alternative : r.code), h('div', { class: 'actions rf-actions' }, rerunButton(rerun)));
    } else {
      card.append(statLine(r.analysis.stats), checkList(r.analysis), explanation(r) || '',
        setCode(h('pre', { class: 'rf-code', id: 'rf-code' }), r.code), codeActions(q, r.code, '', rerun));
    }
    main.append(card);
  }

  function refreshRow(key) {
    const row = ui.rows.get(key);
    const d = doc();
    const e = app.entry(key);
    if (!row || !e || !d) return;
    const cur = normalizeDescription(app.desc(e));
    row.classList.toggle('is-changed', e.editable && cur !== normalizeDescription(e.originalDesc));
    row.classList.toggle('is-empty', e.editable && cur === '');
    row.classList.toggle('is-readonly', !e.editable);
    const aiText = d.aiFilled.get(key);
    row.classList.toggle('is-ai', aiText !== undefined && aiText === cur);
    const ta = /** @type {HTMLTextAreaElement|null} */ (row.querySelector('textarea'));
    if (ta && document.activeElement !== ta && ta.value !== app.desc(e)) {
      ta.value = app.desc(e);
      autoGrow(ta);
    }
  }

  function updateCounts() {
    const q = queryOf(ui.current);
    if (q) {
      updateSideItem(q);
      const s = stats(q);
      const el = main.querySelector('#mq-stats');
      if (el) el.textContent = `${fmt(q.steps.length)} step · ${fmt(s.filled)}/${fmt(s.total)} terisi`;
    }
  }

  function renderAll() {
    renderSidebar();
    renderMain();
  }

  filterSel.addEventListener('change', () => {
    ui.filter = filterSel.value;
    renderSidebar();
  });

  const visible = () => app.step === 'edit' && app.editMode === 'mquery';
  app.on('docs', () => {
    ui.current = null;
    if (visible()) renderAll();
  });
  app.on('active', () => {
    ui.current = null;
    if (visible()) renderAll();
  });
  app.on('editmode', (mode) => {
    if (mode === 'mquery') renderAll();
  });
  app.on('step', () => {
    if (visible()) renderAll();
  });
  app.on('edit', (key) => {
    if (!visible()) return;
    refreshRow(key);
    const cq = queryOf(ui.current);
    if (cq && key.startsWith('step|' + cq.key + '|')) refreshFullCode(cq);
    // A table description edited here is also the query description of its partitions.
    for (const q of doc().queries) if (q.descKey === key && q.key !== ui.current) updateSideItem(q);
    updateCounts();
  });
  app.on('bulk', () => {
    if (visible()) renderAll();
  });
  app.on('aisettings', () => {
    if (visible()) renderMain();
  });
}
