// Step 2: editor. Sidebar of tables with progress, one active table rendered at a
// time; cross-table views ("Semua kosong", search) are paginated (200 rows).

import { itemStatus, progress } from '../core/items.js';
import { normalizeDescription } from '../core/writer.js';
import { truncate } from '../core/text.js';
import { h, $, clear, autoGrow, fmt } from './dom.js';
import { initTools } from './tools.js';
import { initAi } from './ai.js';

const PAGE_SIZES = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 25;
const LINE_MAX = 300;
const SUMMARY_LINES = 3;
const LONG_DESC = 500;
const TYPE_LABEL = { table: 'Tabel', column: 'Kolom', measure: 'Measure' };

/**
 * @param {any} app
 * @param {HTMLElement} root
 */
export function initGrid(app, root) {
  const ui = {
    /** @type {{kind:'table', table:string}|{kind:'empty'}} */
    view: { kind: 'empty' },
    filter: 'all',
    /** @type {'all'|'column'|'measure'} */
    typeFilter: 'all',
    pageSize: PAGE_SIZES.includes(app.prefs.pageSize) ? app.prefs.pageSize : DEFAULT_PAGE_SIZE,
    hideHidden: !!app.prefs.hideHidden,
    sort: app.prefs.sort === 'empty' ? 'empty' : 'name',
    search: '',
    page: 0,
    /** @type {Map<string, HTMLElement>} */
    rows: new Map(),
    /** @type {Map<string, HTMLElement>} */
    sideItems: new Map(),
  };

  // ---------- skeleton ----------
  const sideList = h('div', { class: 'side-list', role: 'listbox', 'aria-label': 'Tabel' });
  const sortSel = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Urutkan tabel' },
    h('option', { value: 'name', text: 'Urut: nama' }),
    h('option', { value: 'empty', text: 'Urut: paling banyak kosong' })));
  sortSel.value = ui.sort;
  const emptyBtn = h('button', { type: 'button', class: 'side-item special', dataset: { view: 'empty' } },
    h('span', { class: 'side-name', text: 'Semua yang kosong' }), h('span', { class: 'side-count', id: 'empty-count' }));

  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search', class: 'search', id: 'grid-search', placeholder: 'Cari nama tabel/kolom/measure (Ctrl+F)', 'aria-label': 'Cari nama',
  }));
  const filterSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Filter' },
    ...[['all', 'Semua'], ['empty', 'Kosong'], ['filled', 'Terisi'], ['changed', 'Diubah']].map(([v, label]) =>
      h('button', { type: 'button', role: 'radio', class: 'seg-btn', dataset: { filter: v }, text: label })));
  const typeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Filter tipe objek', id: 'type-filter' },
    ...[['all', 'Semua tipe'], ['column', 'Hanya Kolom'], ['measure', 'Hanya Measure']].map(([v, label]) =>
      h('button', { type: 'button', role: 'radio', class: 'seg-btn', dataset: { type: v }, text: label })));
  const hideHiddenCb = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'hide-hidden' }));
  hideHiddenCb.checked = ui.hideHidden;
  const toolsBar = h('div', { class: 'tools' });
  const draftSlot = h('div');
  const viewHead = h('div', { class: 'view-head' });
  const tbody = h('tbody');
  const selectAll = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', 'aria-label': 'Pilih semua di tampilan ini' }));
  const table = h('table', { class: 'grid' },
    h('thead', null, h('tr', null,
      h('th', { class: 'c-sel' }, selectAll),
      h('th', { class: 'c-type', text: 'Tipe' }),
      h('th', { class: 'c-name', text: 'Nama' }),
      h('th', { class: 'c-dtype', text: 'DataType' }),
      h('th', { class: 'c-expr', text: 'Ekspresi' }),
      h('th', { class: 'c-desc', text: 'Deskripsi' }))),
    tbody);
  const emptyState = h('div', { class: 'empty-state', hidden: true });
  const pager = h('div', { class: 'pager' });
  const hint = h('p', { class: 'kbd-hint muted' },
    h('kbd', { text: 'Enter' }), ' simpan & ke baris berikutnya · ',
    h('kbd', { text: 'Shift+Enter' }), ' baris baru · ',
    h('kbd', { text: 'Esc' }), ' batalkan perubahan sel · ',
    h('kbd', { text: 'Ctrl+F' }), ' cari');

  root.append(h('div', { class: 'edit-layout' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'side-head' }, h('strong', { text: 'Tabel' }), sortSel),
      emptyBtn,
      sideList),
    h('section', { class: 'editor' },
      draftSlot,
      h('div', { class: 'toolbar' },
        search,
        typeSeg,
        filterSeg,
        h('label', { class: 'check', for: 'hide-hidden' }, hideHiddenCb, ' Sembunyikan objek hidden')),
      toolsBar,
      viewHead,
      h('div', { class: 'grid-wrap' }, table, emptyState),
      pager,
      hint)));

  // ---------- derived data ----------
  const doc = () => app.doc();

  function currentGroup() {
    if (ui.view.kind !== 'table') return null;
    const key = ui.view.table;
    return doc().tables.find((t) => t.key === key) || null;
  }

  function isCrossTable() {
    return ui.search.trim() !== '' || ui.view.kind !== 'table';
  }

  /** Items of the current view after search / filter / hidden. */
  function viewItems() {
    const d = doc();
    if (!d) return [];
    const q = ui.search.trim().toLowerCase();
    let base;
    if (q) base = d.items.filter((it) => it.name.toLowerCase().includes(q) || it.table.toLowerCase().includes(q));
    else if (ui.view.kind === 'empty') base = d.items.filter((it) => it.editable && !itemStatus(it, d.edits).filled);
    else base = (currentGroup() || { items: [] }).items;
    return base.filter((it) => {
      if (ui.hideHidden && it.isHidden) return false;
      if (ui.typeFilter !== 'all' && it.type !== ui.typeFilter) return false;
      if (ui.filter === 'all') return true;
      const s = itemStatus(it, d.edits);
      if (ui.filter === 'empty') return it.editable && !s.filled;
      if (ui.filter === 'filled') return s.filled;
      return s.changed;
    });
  }

  // ---------- sidebar ----------
  function renderSidebar() {
    clear(sideList);
    ui.sideItems.clear();
    const d = doc();
    if (!d) return;
    const stats = new Map(d.tables.map((t) => [t.key, progress(t.items, d.edits)]));
    const tables = d.tables.slice();
    if (ui.sort === 'name') tables.sort((a, b) => a.name.localeCompare(b.name, 'id', { sensitivity: 'base' }));
    else tables.sort((a, b) => {
      const sa = stats.get(a.key);
      const sb = stats.get(b.key);
      return (sb.total - sb.filled) - (sa.total - sa.filled) || a.name.localeCompare(b.name);
    });
    for (const t of tables) {
      const el = h('button', { type: 'button', class: 'side-item', role: 'option', dataset: { table: t.key }, title: t.name },
        h('span', { class: 'side-name' }, t.name, t.editable ? null : h('span', { class: 'tag tiny', text: 'ref' })),
        h('span', { class: 'side-count' }),
        h('span', { class: 'side-bar' }, h('span')));
      el.addEventListener('click', () => {
        ui.view = { kind: 'table', table: t.key };
        ui.search = '';
        search.value = '';
        ui.page = 0;
        renderAll();
      });
      ui.sideItems.set(t.key, el);
      updateSideItem(t.key, stats.get(t.key));
      sideList.append(el);
    }
    markActiveSide();
    updateEmptyCount();
  }

  function updateSideItem(tableKey, stat) {
    const el = ui.sideItems.get(tableKey);
    if (!el) return;
    const d = doc();
    const st = stat || progress(d.tables.find((t) => t.key === tableKey).items, d.edits);
    el.querySelector('.side-count').textContent = `${st.filled}/${st.total}`;
    const pct = st.total ? (st.filled / st.total) * 100 : 100;
    /** @type {HTMLElement} */ (el.querySelector('.side-bar > span')).style.width = pct + '%';
    el.classList.toggle('complete', st.total > 0 && st.filled === st.total);
    el.classList.toggle('has-changes', st.changed > 0);
  }

  function updateEmptyCount() {
    const d = doc();
    if (!d) return;
    const p = progress(d.items, d.edits);
    $('#empty-count', root).textContent = fmt(p.total - p.filled);
  }

  function markActiveSide() {
    const searching = ui.search.trim() !== '';
    emptyBtn.classList.toggle('active', !searching && ui.view.kind === 'empty');
    for (const [k, el] of ui.sideItems) {
      const on = !searching && ui.view.kind === 'table' && ui.view.table === k;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', String(on));
    }
  }

  // ---------- grid ----------
  function renderGrid() {
    clear(tbody);
    ui.rows.clear();
    const d = doc();
    if (!d) return;
    const items = viewItems();
    const size = ui.pageSize;
    const pages = Math.max(1, Math.ceil(items.length / size));
    if (ui.page >= pages) ui.page = pages - 1;
    const slice = items.slice(ui.page * size, (ui.page + 1) * size);
    const cross = isCrossTable();
    const frag = document.createDocumentFragment();
    for (const it of slice) frag.append(renderRow(it, cross));
    tbody.append(frag);
    requestAnimationFrame(() => {
      for (const ta of tbody.querySelectorAll('textarea')) autoGrow(/** @type {HTMLTextAreaElement} */ (ta));
    });

    // View head.
    clear(viewHead);
    const q = ui.search.trim();
    let title;
    if (q) title = `Hasil pencarian "${q}"`;
    else if (ui.view.kind === 'empty') title = 'Semua objek yang belum punya deskripsi';
    else {
      const g = currentGroup();
      title = g ? g.name : '';
    }
    viewHead.append(
      h('h2', { text: title }),
      h('span', { class: 'muted', text: `${fmt(items.length)} objek` + (pages > 1 ? ` · halaman ${ui.page + 1}/${pages}` : '') }));
    if (!q && ui.view.kind === 'table' && currentGroup() && !currentGroup().editable) {
      viewHead.append(h('span', { class: 'tag warn', text: 'ref table: deskripsi tabel tidak bisa diubah di script ini' }));
    }

    // Empty state.
    emptyState.hidden = items.length > 0;
    table.hidden = items.length === 0;
    if (!items.length) {
      clear(emptyState);
      emptyState.append(h('p', {
        text: ui.view.kind === 'empty' && !q && ui.filter === 'all' && ui.typeFilter === 'all'
          ? 'Semua objek sudah punya deskripsi. 🎉'
          : 'Tidak ada objek yang cocok dengan filter ini.',
      }));
    }

    // Pager.
    clear(pager);
    if (items.length) {
      const sizeSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'page-size', 'aria-label': 'Baris per halaman' },
        PAGE_SIZES.map((n) => h('option', { value: String(n), text: String(n) }))));
      sizeSel.value = String(size);
      sizeSel.addEventListener('change', () => {
        const first = ui.page * ui.pageSize; // keep the first visible row on screen
        ui.pageSize = Number(sizeSel.value);
        ui.page = Math.floor(first / ui.pageSize);
        app.savePrefs({ pageSize: ui.pageSize });
        renderGrid();
      });
      pager.append(
        h('label', { class: 'page-size' }, 'Baris per halaman ', sizeSel),
        h('span', { class: 'muted page-range', id: 'page-range', text: `${fmt(ui.page * size + 1)}–${fmt(Math.min(items.length, (ui.page + 1) * size))} dari ${fmt(items.length)}` }),
        h('span', { class: 'page-nav' },
          h('button', { type: 'button', class: 'btn small', id: 'page-prev', text: '← Sebelumnya', disabled: ui.page === 0, onclick: () => goPage(ui.page - 1) }),
          h('span', { class: 'muted', text: `${ui.page + 1}/${pages}` }),
          h('button', { type: 'button', class: 'btn small', id: 'page-next', text: 'Berikutnya →', disabled: ui.page >= pages - 1, onclick: () => goPage(ui.page + 1) })));
    }
    updateSelectAll();
  }

  function goPage(p) {
    ui.page = p;
    renderGrid();
    root.querySelector('.grid-wrap').scrollIntoView({ block: 'start' });
  }

  function exprSummary(expr) {
    const lines = expr.split('\n');
    const short = lines.slice(0, SUMMARY_LINES).map((l) => truncate(l, LINE_MAX)).join('\n');
    const full = lines.map((l) => truncate(l, LINE_MAX)).join('\n');
    return { short, full, more: lines.length > SUMMARY_LINES || full !== short };
  }

  function renderRow(it, cross) {
    const d = doc();
    const st = itemStatus(it, d.edits);
    const ta = /** @type {HTMLTextAreaElement} */ (h('textarea', {
      class: 'desc', rows: 1, spellcheck: true, dataset: { key: it.key },
      'aria-label': `Deskripsi ${TYPE_LABEL[it.type]} ${it.name}`,
      disabled: !it.editable,
      placeholder: it.editable ? 'Tulis deskripsi…' : 'ref table: deskripsi tidak bisa diubah dari script parsial ini',
    }));
    ta.value = app.desc(it);
    const resetBtn = h('button', { type: 'button', class: 'icon-btn reset', title: 'Kembalikan ke deskripsi asli', 'aria-label': 'Reset', text: '↺' });
    const aiBtn = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', class: 'icon-btn ai-suggest', title: 'Isi dengan saran AI', 'aria-label': 'Saran AI untuk ' + it.name, text: '✨', disabled: !it.editable,
    }));
    const meta = h('div', { class: 'desc-meta' },
      h('span', { class: 'ai-mark', title: 'Diisi dengan saran AI. Periksa sebelum dipakai.', text: '✨ saran AI' }),
      h('span', { class: 'changed-mark', text: 'diubah' }), h('span', { class: 'len-warn' }), resetBtn, aiBtn);
    const cb = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', 'aria-label': 'Pilih ' + it.name, disabled: !it.editable }));
    cb.checked = d.selected.has(it.key);

    let exprCell = null;
    if (it.expression) {
      const s = exprSummary(it.expression);
      const pre = h('pre', { class: 'expr', title: s.full.length < 4000 ? s.full : undefined, text: s.short });
      exprCell = [pre];
      if (s.more) {
        const btn = h('button', { type: 'button', class: 'link-btn', text: 'selengkapnya' });
        btn.addEventListener('click', () => {
          const open = pre.classList.toggle('expanded');
          pre.textContent = open ? s.full : s.short;
          btn.textContent = open ? 'ringkas' : 'selengkapnya';
        });
        exprCell.push(btn);
      }
    }

    const nameCell = h('td', { class: 'c-name' },
      cross && it.type !== 'table' ? h('span', { class: 'table-prefix', text: it.table + ' › ' }) : null,
      h('span', { class: 'obj-name', text: it.name }),
      it.isHidden ? h('span', { class: 'tag tiny', text: 'hidden' }) : null,
      it.occurrences > 1 ? h('span', { class: 'tag tiny', title: `Dideklarasikan ${it.occurrences} kali; semua kemunculan akan diperbarui`, text: '×' + it.occurrences }) : null);

    const row = h('tr', { class: 'row t-' + it.type, dataset: { key: it.key } },
      h('td', { class: 'c-sel' }, cb),
      h('td', { class: 'c-type' }, h('span', { class: 'type-badge ' + it.type, text: TYPE_LABEL[it.type] })),
      nameCell,
      h('td', { class: 'c-dtype', text: it.dataType || '' }),
      h('td', { class: 'c-expr' }, exprCell),
      h('td', { class: 'c-desc' }, ta, meta));
    row.classList.toggle('is-changed', st.changed);
    row.classList.toggle('is-empty', it.editable && !st.filled);
    row.classList.toggle('is-readonly', !it.editable);
    updateLen(row, ta.value);

    ta.addEventListener('focus', () => {
      ta.dataset.before = ta.value;
    });
    ta.addEventListener('input', () => {
      autoGrow(ta);
      app.setDesc(it.key, ta.value);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        focusNext(row);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        const before = ta.dataset.before ?? app.desc(it);
        ta.value = before;
        autoGrow(ta);
        app.setDesc(it.key, before);
      }
    });
    aiBtn.addEventListener('click', () => ai.suggestOne(it, aiBtn));
    resetBtn.addEventListener('click', () => {
      ta.value = it.originalDesc;
      autoGrow(ta);
      app.setDesc(it.key, it.originalDesc);
      ta.focus();
    });
    cb.addEventListener('change', () => {
      if (cb.checked) d.selected.add(it.key);
      else d.selected.delete(it.key);
      updateSelectAll();
      tools.refresh();
    });
    ui.rows.set(it.key, row);
    return row;
  }

  function updateLen(row, value) {
    const n = normalizeDescription(value).length;
    row.querySelector('.len-warn').textContent = n > LONG_DESC ? `${fmt(n)} karakter (panjang)` : '';
    const d = doc();
    const aiText = d && d.aiFilled.get(row.dataset.key);
    row.classList.toggle('is-ai', aiText !== undefined && aiText === normalizeDescription(value));
  }

  function focusNext(row) {
    let next = /** @type {HTMLElement|null} */ (row.nextElementSibling);
    while (next) {
      const ta = /** @type {HTMLTextAreaElement|null} */ (next.querySelector('textarea:not([disabled])'));
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }
      next = /** @type {HTMLElement|null} */ (next.nextElementSibling);
    }
    /** @type {HTMLElement} */ (document.activeElement).blur();
  }

  function refreshRow(key) {
    const row = ui.rows.get(key);
    const d = doc();
    const it = d.byKey.get(key);
    if (!row || !it) return;
    const st = itemStatus(it, d.edits);
    row.classList.toggle('is-changed', st.changed);
    row.classList.toggle('is-empty', it.editable && !st.filled);
    const ta = /** @type {HTMLTextAreaElement} */ (row.querySelector('textarea'));
    if (document.activeElement !== ta && ta.value !== app.desc(it)) {
      ta.value = app.desc(it);
      autoGrow(ta);
    }
    updateLen(row, ta.value);
  }

  // ---------- selection ----------
  function updateSelectAll() {
    const d = doc();
    if (!d) return;
    const items = viewItems().filter((it) => it.editable);
    const sel = items.filter((it) => d.selected.has(it.key)).length;
    selectAll.checked = items.length > 0 && sel === items.length;
    selectAll.indeterminate = sel > 0 && sel < items.length;
    selectAll.title = `Pilih semua ${items.length} objek di tampilan ini (semua halaman)`;
  }
  selectAll.addEventListener('change', () => {
    const d = doc();
    const items = viewItems().filter((it) => it.editable);
    for (const it of items) {
      if (selectAll.checked) d.selected.add(it.key);
      else d.selected.delete(it.key);
    }
    for (const [k, row] of ui.rows) {
      const cb = /** @type {HTMLInputElement} */ (row.querySelector('.c-sel input'));
      cb.checked = d.selected.has(k);
    }
    updateSelectAll();
    tools.refresh();
  });

  // ---------- draft banner ----------
  function renderDraft() {
    clear(draftSlot);
    const d = doc();
    if (!d || !d.draft) return;
    draftSlot.append(h('div', { class: 'banner info' },
      h('span', null, `Ada draft tersimpan (${fmt(d.draft.edits.length)} perubahan, ${new Date(d.draft.savedAt).toLocaleString('id-ID')}). Mengedit tanpa memulihkan akan menimpanya.`),
      h('span', { class: 'banner-actions' },
        h('button', { class: 'btn small primary', type: 'button', text: 'Pulihkan', onclick: () => app.restoreDraft(d) }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Abaikan', onclick: () => app.discardDraft(d) }))));
  }

  // ---------- toolbar wiring ----------
  function markFilter() {
    for (const b of filterSeg.querySelectorAll('.seg-btn')) {
      const on = /** @type {HTMLElement} */ (b).dataset.filter === ui.filter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  function markType() {
    for (const b of typeSeg.querySelectorAll('.seg-btn')) {
      const on = /** @type {HTMLElement} */ (b).dataset.type === ui.typeFilter;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  typeSeg.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.seg-btn');
    if (!b) return;
    ui.typeFilter = /** @type {any} */ (/** @type {HTMLElement} */ (b).dataset.type);
    ui.page = 0;
    markType();
    renderGrid();
  });
  filterSeg.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.seg-btn');
    if (!b) return;
    ui.filter = /** @type {HTMLElement} */ (b).dataset.filter;
    ui.page = 0;
    markFilter();
    renderGrid();
  });
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      ui.search = search.value;
      ui.page = 0;
      markActiveSide();
      renderGrid();
    }, 150);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && search.value) {
      search.value = '';
      ui.search = '';
      markActiveSide();
      renderGrid();
    }
  });
  hideHiddenCb.addEventListener('change', () => {
    ui.hideHidden = hideHiddenCb.checked;
    app.savePrefs({ hideHidden: ui.hideHidden });
    ui.page = 0;
    renderGrid();
  });
  sortSel.addEventListener('change', () => {
    ui.sort = /** @type {any} */ (sortSel.value);
    app.savePrefs({ sort: ui.sort });
    renderSidebar();
  });
  emptyBtn.addEventListener('click', () => {
    ui.view = { kind: 'empty' };
    ui.search = '';
    search.value = '';
    ui.page = 0;
    renderAll();
  });
  document.addEventListener('keydown', (e) => {
    if (app.step !== 'edit' || app.editMode !== 'objects') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
      search.select();
    }
  });

  const selectedItems = () => {
    const d = doc();
    return d ? d.items.filter((it) => d.selected.has(it.key) && it.editable) : [];
  };
  const ai = initAi(app, { viewItems, selectedItems });
  app.ai = ai;
  const tools = initTools(app, toolsBar, { viewItems, selectedItems, ai });

  // ---------- lifecycle ----------
  function defaultView() {
    const d = doc();
    if (!d) return;
    const p = progress(d.items, d.edits);
    const firstEditable = d.tables.find((t) => t.items.some((i) => i.editable));
    // Small scripts: open the first table. Large models with gaps: start at "Semua kosong".
    if (d.tables.length <= 3 && firstEditable) ui.view = { kind: 'table', table: firstEditable.key };
    else if (p.total - p.filled > 0) ui.view = { kind: 'empty' };
    else if (firstEditable) ui.view = { kind: 'table', table: firstEditable.key };
    ui.page = 0;
    ui.search = '';
    search.value = '';
  }

  function renderAll() {
    renderDraft();
    renderSidebar();
    renderGrid();
    tools.refresh();
  }

  markFilter();
  markType();
  app.on('docs', () => {
    defaultView();
    renderAll();
  });
  app.on('active', () => {
    defaultView();
    renderAll();
  });
  app.on('step', (s) => {
    if (s === 'edit' && app.editMode === 'objects') renderAll();
  });
  app.on('editmode', (mode) => {
    if (mode === 'objects') renderAll();
  });
  app.on('draft', () => renderDraft());
  app.on('edit', (key) => {
    refreshRow(key);
    const it = doc().byKey.get(key);
    if (it) updateSideItem(it.table.toLowerCase());
    updateEmptyCount();
  });
  app.on('bulk', () => {
    if (app.step === 'edit' && app.editMode === 'objects') renderAll();
  });
}
