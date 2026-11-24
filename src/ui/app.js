// Bootstrap + state store. Panels get the `app` object and subscribe to events.
// UI never edits TMDL text itself: it only keeps an edits Map and calls core.

import { parseTmdl } from '../core/parser.js';
import { collectQueries } from '../core/mquery.js';
import { buildItems, progress, currentDescription } from '../core/items.js';
import { normalizeDescription } from '../core/writer.js';
import { hashText } from '../core/text.js';
import { $, debounce, fmt } from './dom.js';
import * as storage from './storage.js';
import { initInput } from './input-panel.js';
import { initGrid } from './grid.js';
import { initOutput } from './output-panel.js';
import { initMPanel } from './mquery-panel.js';
import { h } from './dom.js';

/**
 * @typedef {Object} Doc
 * @property {number} id
 * @property {string} name        file name or "Script (tempel)"
 * @property {boolean} fromFile
 * @property {string} text        original text, untouched
 * @property {string} hash
 * @property {import('../core/parser.js').ParseResult} parsed
 * @property {import('../core/items.js').EditorItem[]} items
 * @property {Map<string, import('../core/items.js').EditorItem>} byKey
 * @property {import('../core/items.js').TableGroup[]} tables
 * @property {Map<string,string>} edits
 * @property {import('./storage.js').Draft|null} draft   draft offered for restore
 * @property {Set<string>} selected
 * @property {Map<string,string>} aiFilled  key → description last written by AI (for the ✨ marker)
 * @property {import('../core/mquery.js').MQuery[]} queries  Power Query queries (m partitions + expressions)
 * @property {Map<string, {key:string, originalDesc:string, editable:boolean}>} mByKey  expressions + steps
 * @property {Map<string, any>} refactors  query key → AI refactor result (session only, never written to TMDL)
 */

/** Editable entries of the Power Query view: expression descriptions and step descriptions. */
function buildMIndex(parsed, queries) {
  const m = new Map();
  for (const o of parsed.objects) {
    if (o.type !== 'expression') continue;
    const prev = m.get(o.key);
    if (!prev || (!prev.editable && o.editable)) m.set(o.key, { key: o.key, originalDesc: o.originalDesc, editable: o.editable });
  }
  for (const q of queries) {
    for (const st of q.steps) m.set(st.key, { key: st.key, originalDesc: st.originalDesc, editable: st.commentable });
  }
  return m;
}

const listeners = new Map();
let nextId = 1;

const app = {
  /** @type {Doc[]} */
  docs: [],
  active: 0,
  /** @type {'input'|'edit'|'output'} */
  step: 'input',
  /** @type {'objects'|'mquery'} */
  editMode: 'objects',
  prefs: storage.loadPrefs(),
  /** shared AI helper (set by the grid) */
  ai: null,

  /** @returns {Doc|null} */
  doc() {
    return this.docs[this.active] || null;
  },

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, []);
    listeners.get(evt).push(fn);
  },

  emit(evt, payload) {
    for (const fn of listeners.get(evt) || []) fn(payload);
  },

  /**
   * Parse new sources and replace the current documents.
   * @param {{name:string, text:string, fromFile:boolean}[]} sources
   */
  loadDocs(sources) {
    saveNow.flush();
    this.docs = sources.map((s) => {
      const parsed = parseTmdl(s.text);
      const { items, byKey, tables } = buildItems(parsed);
      const queries = collectQueries(parsed);
      const hash = hashText(s.text);
      return {
        id: nextId++,
        name: s.name,
        fromFile: s.fromFile,
        text: s.text,
        hash,
        parsed,
        items,
        byKey,
        tables,
        edits: new Map(),
        draft: storage.loadDraft(hash),
        selected: new Set(),
        aiFilled: new Map(),
        queries,
        mByKey: buildMIndex(parsed, queries),
        refactors: new Map(),
      };
    });
    this.active = 0;
    this.emit('docs');
    this.updateChrome();
  },

  setActive(i) {
    if (i === this.active || !this.docs[i]) return;
    saveNow.flush();
    this.active = i;
    this.emit('active');
    this.updateChrome();
  },

  /** Any editable entry (object item, expression or step) by key. */
  entry(key, doc = this.doc()) {
    return doc.byKey.get(key) || doc.mByKey.get(key) || null;
  },

  setEditMode(mode) {
    if (mode === this.editMode) return;
    this.editMode = mode;
    this.emit('editmode', mode);
  },

  /** Current description text for an item of the active doc. */
  desc(item, doc = this.doc()) {
    return currentDescription(item, doc.edits);
  },

  /**
   * Record an edit. Values equal to the original are dropped from the map.
   * @param {string} key
   * @param {string} value
   * @param {{silent?:boolean}} [opt]
   */
  setDesc(key, value, opt = {}, doc = this.doc()) {
    const item = this.entry(key, doc);
    if (!item || !item.editable) return;
    if (doc.draft) {
      // Editing without restoring = starting fresh; the old draft will be overwritten.
      doc.draft = null;
      this.emit('draft', doc);
    }
    if (normalizeDescription(value) === normalizeDescription(item.originalDesc)) doc.edits.delete(key);
    else doc.edits.set(key, value);
    saveNow();
    if (!opt.silent) this.emit('edit', key);
    this.updateProgress();
  },

  /** Apply many edits at once (Excel import, AI fill, bulk fill, replace). */
  setMany(pairs, doc = this.doc()) {
    for (const [k, v] of pairs) this.setDesc(k, v, { silent: true }, doc);
    this.emit('bulk');
    this.updateProgress();
  },

  restoreDraft(doc) {
    const draft = doc.draft;
    if (!draft) return 0;
    doc.draft = null;
    let n = 0;
    for (const [k, v] of draft.edits) {
      const item = this.entry(k, doc);
      if (item && item.editable) {
        this.setDesc(k, v, { silent: true }, doc);
        n++;
      }
    }
    this.emit('draft', doc);
    this.emit('bulk');
    this.updateProgress();
    return n;
  },

  discardDraft(doc) {
    if (doc.draft) storage.deleteDraft(doc.hash);
    doc.draft = null;
    this.emit('draft', doc);
  },

  savePrefs(patch) {
    Object.assign(this.prefs, patch);
    storage.savePrefs(patch);
  },

  goto(step) {
    if (step !== 'input' && !this.doc()) return;
    this.step = step;
    for (const s of ['input', 'edit', 'output']) {
      const tab = $('#tab-' + s);
      const panel = $('#panel-' + s);
      tab.setAttribute('aria-selected', String(s === step));
      tab.classList.toggle('active', s === step);
      panel.hidden = s !== step;
    }
    this.emit('step', step);
    window.scrollTo(0, 0);
  },

  updateChrome() {
    const has = this.docs.length > 0;
    $('#tab-edit').disabled = !has;
    $('#tab-output').disabled = !has;
    const sw = $('#doc-switch');
    const sel = /** @type {HTMLSelectElement} */ ($('#doc-select'));
    sw.hidden = this.docs.length < 2;
    sel.textContent = '';
    this.docs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = d.name;
      o.selected = i === this.active;
      sel.append(o);
    });
    this.updateProgress();
  },

  updateProgress() {
    const doc = this.doc();
    const box = $('#progress-total');
    if (!doc) {
      box.hidden = true;
      return;
    }
    const p = progress(doc.items, doc.edits);
    box.hidden = false;
    const pct = p.total ? Math.floor((p.filled / p.total) * 100) : 0; // floor: 100% only when complete
    $('#progress-fill').style.width = pct + '%';
    $('#progress-text').textContent = `${fmt(p.filled)}/${fmt(p.total)} (${pct}%) terisi · ${fmt(p.changed)} diubah`;
    box.title = `${pct}% objek yang bisa diedit sudah punya deskripsi`;
  },
};

// Autosave (debounced 500 ms) for every doc with a pending change.
const saveNow = debounce(() => {
  for (const d of app.docs) {
    if (d.draft) continue; // don't overwrite an unrestored draft with an empty edit set
    storage.saveDraft(d.hash, d.name, d.edits);
  }
}, 500);
window.addEventListener('beforeunload', () => saveNow.flush());

function boot() {
  for (const s of ['input', 'edit', 'output']) {
    $('#tab-' + s).addEventListener('click', () => app.goto(/** @type {any} */ (s)));
  }
  $('#doc-select').addEventListener('change', (e) => app.setActive(Number(/** @type {HTMLSelectElement} */ (e.target).value)));
  initInput(app, $('#panel-input'));
  const editPanel = $('#panel-edit');
  const modeBar = h('div', { class: 'mode-bar', role: 'tablist', 'aria-label': 'Jenis deskripsi' },
    h('button', { type: 'button', class: 'mode-btn active', role: 'tab', id: 'mode-objects', dataset: { mode: 'objects' }, text: 'Tabel, kolom & measure' }),
    h('button', { type: 'button', class: 'mode-btn', role: 'tab', id: 'mode-mquery', dataset: { mode: 'mquery' } }, 'Power Query (M) ', h('span', { class: 'mode-count', id: 'mode-mquery-count' })));
  const gridRoot = h('div', { id: 'objects-root' });
  const mRoot = h('div', { id: 'mquery-root', hidden: true });
  editPanel.append(modeBar, gridRoot, mRoot);
  modeBar.addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.mode-btn');
    if (b) app.setEditMode(/** @type {any} */ (b.dataset.mode));
  });
  app.on('editmode', (mode) => {
    for (const b of modeBar.querySelectorAll('.mode-btn')) {
      const on = /** @type {HTMLElement} */ (b).dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    gridRoot.hidden = mode !== 'objects';
    mRoot.hidden = mode !== 'mquery';
  });
  const updateMCount = () => {
    const d = app.doc();
    const n = d ? d.queries.length : 0;
    $('#mode-mquery-count').textContent = n ? `(${fmt(n)} query)` : '(tidak ada)';
  };
  app.on('docs', updateMCount);
  app.on('active', updateMCount);
  initGrid(app, gridRoot);
  initMPanel(app, mRoot);
  initOutput(app, $('#panel-output'));
  app.goto('input');
  app.updateChrome();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

