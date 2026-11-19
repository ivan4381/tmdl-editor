// Bootstrap + state store. Panels get the `app` object and subscribe to events.
// UI never edits TMDL text itself: it only keeps an edits Map and calls core.

import { parseTmdl } from '../core/parser.js';
import { buildItems, progress, currentDescription } from '../core/items.js';
import { normalizeDescription } from '../core/writer.js';
import { hashText } from '../core/text.js';
import { $, debounce, fmt } from './dom.js';
import * as storage from './storage.js';
import { initInput } from './input-panel.js';
import { initGrid } from './grid.js';
import { initOutput } from './output-panel.js';

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
 */

const listeners = new Map();
let nextId = 1;

const app = {
  /** @type {Doc[]} */
  docs: [],
  active: 0,
  /** @type {'input'|'edit'|'output'} */
  step: 'input',
  prefs: storage.loadPrefs(),

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
    const item = doc.byKey.get(key);
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
      const item = doc.byKey.get(k);
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
    const pct = p.total ? Math.round((p.filled / p.total) * 100) : 0;
    $('#progress-fill').style.width = pct + '%';
    $('#progress-text').textContent = `${fmt(p.filled)}/${fmt(p.total)} terisi · ${fmt(p.changed)} diubah`;
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
  initGrid(app, $('#panel-edit'));
  initOutput(app, $('#panel-output'));
  app.goto('input');
  app.updateChrome();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

