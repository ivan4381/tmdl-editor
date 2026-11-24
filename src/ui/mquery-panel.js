// Edit step, "Power Query (M)" mode: query descriptions and per-step descriptions
// (`//` comments above each step, shown as step descriptions in Power Query).

import { normalizeDescription } from '../core/writer.js';
import { truncate } from '../core/text.js';
import { h, clear, autoGrow, fmt } from './dom.js';

const LINE_MAX = 300;
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
    const groups = [
      ['partition', 'Query tabel'],
      ['expression', 'Parameter, fungsi & staging'],
    ];
    for (const [kind, title] of groups) {
      let qs = d.queries.filter((q) => q.kind === kind);
      if (ui.filter === 'todo') qs = qs.filter((q) => {
        const s = stats(q);
        return s.filled < s.total;
      });
      if (!qs.length) continue;
      sideList.append(h('div', { class: 'side-group', text: title }));
      for (const q of qs) {
        const el = h('button', { type: 'button', class: 'side-item', role: 'option', dataset: { query: q.key }, title: label(q) },
          h('span', { class: 'side-name' }, label(q), q.error ? h('span', { class: 'tag tiny warn', text: 'M tak dikenali' }) : null),
          h('span', { class: 'side-count' }),
          h('span', { class: 'side-bar' }, h('span')));
        el.addEventListener('click', () => {
          ui.current = q.key;
          markActive(); // keep the sidebar list (and its scroll position) as it is
          renderMain();
        });
        ui.sideItems.set(q.key, el);
        updateSideItem(q);
        sideList.append(el);
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
    const pre = h('pre', { class: 'expr', text: short });
    const out = [pre];
    if (lines.length > CODE_PREVIEW_LINES) {
      const btn = h('button', { type: 'button', class: 'link-btn', text: 'selengkapnya' });
      btn.addEventListener('click', () => {
        const open = pre.classList.toggle('expanded');
        pre.textContent = open ? full : short;
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
    const toolbar = h('div', { class: 'tools' },
      h('span', { class: 'muted', text: 'Deskripsi step ditulis sebagai komentar // di atas step dan tampil di Applied Steps Power Query.' }),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn small ai-btn', id: 'mq-ai-query', text: '✨ Isi query ini…', onclick: () => ai.openBulkM({ current: q }) }),
      h('button', { type: 'button', class: 'btn small ai-btn', id: 'mq-ai-all', text: '✨ Isi semua query…', onclick: () => ai.openBulkM() }),
      h('button', { type: 'button', class: 'btn small', title: 'Pengaturan AI', text: '⚙ AI', onclick: () => ai.openSettings() }));
    const s = stats(q);
    const head = h('div', { class: 'view-head' },
      h('h2', { text: label(q) }),
      h('span', { class: 'type-badge ' + (q.kind === 'partition' ? 'table' : 'measure'), text: q.kind === 'partition' ? 'Query tabel' : 'Expression' }),
      h('span', { class: 'muted', id: 'mq-stats', text: `${fmt(q.steps.length)} step · ${fmt(s.filled)}/${fmt(s.total)} terisi` }));
    main.append(toolbar, head);
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
      main.append(h('details', { class: 'code-details' }, h('summary', { text: 'Lihat kode M lengkap' }),
        h('pre', { class: 'expr expanded code-full', text: q.code.split('\n').map((l) => truncate(l, LINE_MAX)).join('\n') })));
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
    // A table description edited here is also the query description of its partitions.
    for (const q of doc().queries) if (q.descKey === key && q.key !== ui.current) updateSideItem(q);
    updateCounts();
  });
  app.on('bulk', () => {
    if (visible()) renderAll();
  });
}
