// v1.1 tools: Excel export/import, AI fill, bulk fill with templates, find & replace.

import { buildXlsx, readXlsx } from '../core/xlsx.js';
import { SHEET_COLUMNS, itemsToRows, matchRows } from '../core/sheet.js';
import { applyTemplate, replaceAllLiteral } from '../core/bulk.js';
import { normalizeDescription } from '../core/writer.js';
import { truncate } from '../core/text.js';
import { h, clear, toast, downloadText, openModal, fmt } from './dom.js';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * @param {any} app
 * @param {HTMLElement} bar
 * @param {{viewItems:()=>any[], selectedItems:()=>any[], ai:{openBulk:()=>void, openSettings:(cb?:()=>void)=>void}}} ctx
 */
export function initTools(app, bar, ctx) {
  const selInfo = h('span', { class: 'muted sel-info' });
  const aiBtn = h('button', { type: 'button', class: 'btn small ai-btn', id: 'ai-bulk-btn', text: '✨ Isi dengan AI…' });
  const aiSettingsBtn = h('button', { type: 'button', class: 'btn small', id: 'ai-settings-btn', title: 'Pengaturan AI (API key, model, bahasa)', 'aria-label': 'Pengaturan AI', text: '⚙ AI' });
  const bulkBtn = h('button', { type: 'button', class: 'btn small', text: 'Isi massal…' });
  const replaceBtn = h('button', { type: 'button', class: 'btn small', text: 'Cari & ganti…' });
  const exportBtn = h('button', { type: 'button', class: 'btn small', id: 'xlsx-export-btn', text: 'Export Excel…' });
  const importBtn = h('button', { type: 'button', class: 'btn small', id: 'xlsx-import-btn', text: 'Import Excel…' });
  const clearSelBtn = h('button', { type: 'button', class: 'link-btn', text: 'batal pilih' });
  const fileInput = /** @type {HTMLInputElement} */ (h('input', { type: 'file', id: 'xlsx-file', accept: '.xlsx,' + XLSX_MIME, hidden: true }));
  bar.append(selInfo, clearSelBtn, h('span', { class: 'spacer' }), aiBtn, aiSettingsBtn, bulkBtn, replaceBtn, exportBtn, importBtn, fileInput);

  function refresh() {
    const n = ctx.selectedItems().length;
    selInfo.textContent = n ? `${fmt(n)} objek dipilih` : 'Centang baris untuk isi massal';
    clearSelBtn.hidden = n === 0;
  }

  clearSelBtn.addEventListener('click', () => {
    app.doc().selected.clear();
    app.emit('bulk');
    refresh();
  });

  aiBtn.addEventListener('click', () => ctx.ai.openBulk());
  aiSettingsBtn.addEventListener('click', () => ctx.ai.openSettings());

  // ---------- Excel export ----------
  exportBtn.addEventListener('click', () => {
    const doc = app.doc();
    openModal('Export Excel', (close) => {
      const scope = /** @type {HTMLSelectElement} */ (h('select', { id: 'xlsx-scope' },
        h('option', { value: 'all', text: `Semua objek (${fmt(doc.items.length)})` }),
        h('option', { value: 'view', text: `Tampilan saat ini (${fmt(ctx.viewItems().length)})` })));
      return [
        h('p', { class: 'muted', text: 'Kolom: Table, Type, Name, DataType, IsHidden, Expression, Description. SME cukup mengisi kolom Description, lalu file di-import kembali. Baris dicocokkan lewat Type + Table + Name, jadi jangan ubah tiga kolom itu.' }),
        h('label', { class: 'field' }, h('span', { text: 'Cakupan' }), scope),
        h('div', { class: 'actions' },
          h('button', {
            type: 'button', class: 'btn primary', id: 'xlsx-download', text: 'Download Excel',
            onclick: () => {
              const items = scope.value === 'view' ? ctx.viewItems() : doc.items;
              const bytes = buildXlsx({ sheetName: 'Deskripsi', columns: SHEET_COLUMNS, rows: itemsToRows(items, (it) => app.desc(it)) });
              downloadText(baseName(doc.name) + '.descriptions.xlsx', bytes, XLSX_MIME);
              close();
            },
          }),
          h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })),
      ];
    });
  });

  // ---------- Excel import ----------
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let rows;
    try {
      rows = await readXlsx(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      toast('Gagal membaca file Excel: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    const doc = app.doc();
    const res = matchRows(rows, doc.items, (k) => app.desc(doc.byKey.get(k)));
    openModal('Import Excel: ' + file.name, (close) => {
      if (res.errors.length) {
        return [h('div', { class: 'banner error' }, res.errors.join(' ')), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', text: 'Tutup', onclick: close }))];
      }
      const out = [
        h('div', { class: 'stat-row' },
          stat(res.matched, 'cocok'),
          stat(res.changed.length, 'berubah'),
          stat(res.notFound.length, 'tidak ditemukan'),
          res.readOnly ? stat(res.readOnly, 'read-only (ref)') : null),
        h('p', { class: 'muted', text: 'Sheet pertama yang dibaca. Hanya baris yang berubah yang akan diterapkan.' }),
      ];
      if (res.changed.length) {
        out.push(h('h3', { text: 'Perubahan' }), h('div', { class: 'change-list' },
          res.changed.slice(0, 100).map((c) => h('div', { class: 'change' },
            h('div', { class: 'change-name' }, h('span', { class: 'type-badge ' + c.item.type, text: TYPE_LABEL[c.item.type] }), ` ${c.item.table} › ${c.item.name}`),
            h('div', { class: 'change-from', text: c.from ? truncate(c.from, 300) : '(kosong)' }),
            h('div', { class: 'change-to', text: c.to ? truncate(c.to, 300) : '(dihapus)' }))),
          res.changed.length > 100 ? h('p', { class: 'muted', text: `…dan ${fmt(res.changed.length - 100)} lagi` }) : null));
      }
      if (res.notFound.length) {
        out.push(h('details', null, h('summary', { text: `${fmt(res.notFound.length)} baris tidak ditemukan di script` }),
          h('ul', { class: 'small-list' }, res.notFound.slice(0, 200).map((n) => h('li', { text: `Baris ${n.line}: ${n.type} ${n.table} › ${n.name}` })))));
      }
      out.push(h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn primary', id: 'xlsx-apply', text: `Terapkan ${fmt(res.changed.length)} perubahan`, disabled: res.changed.length === 0,
          onclick: () => {
            app.setMany(res.changed.map((c) => [c.key, c.to]));
            toast(`${res.changed.length} deskripsi diperbarui dari Excel`, 'ok');
            close();
          },
        }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })));
      return out;
    });
  });

  // ---------- bulk fill ----------
  bulkBtn.addEventListener('click', () => {
    const selected = ctx.selectedItems();
    const targetsAll = selected.length === 0;
    const targets = targetsAll ? ctx.viewItems().filter((it) => it.editable) : selected;
    if (!targets.length) {
      toast('Tidak ada objek yang bisa diisi di tampilan ini.', 'error');
      return;
    }
    openModal('Isi massal', (close) => {
      const tpl = /** @type {HTMLTextAreaElement} */ (h('textarea', { class: 'tpl', rows: 3, id: 'bulk-template', placeholder: 'contoh: Kolom {name} pada tabel {table}' }));
      tpl.value = app.prefs.lastTemplate || '';
      const onlyEmpty = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'bulk-only-empty' }));
      onlyEmpty.checked = true;
      const preview = h('div', { class: 'preview' });
      const applyBtn = h('button', { type: 'button', class: 'btn primary', id: 'bulk-apply' });
      const pending = () => targets.filter((it) => !onlyEmpty.checked || normalizeDescription(app.desc(it)) === '');
      const update = () => {
        const list = pending();
        applyBtn.textContent = `Terapkan ke ${fmt(list.length)} objek`;
        /** @type {HTMLButtonElement} */ (applyBtn).disabled = list.length === 0 || normalizeDescription(tpl.value) === '';
        clear(preview);
        for (const it of list.slice(0, 3)) {
          preview.append(h('div', { class: 'preview-row' }, h('strong', { text: `${it.table} › ${it.name}: ` }), applyTemplate(normalizeDescription(tpl.value), it) || '—'));
        }
      };
      tpl.addEventListener('input', update);
      onlyEmpty.addEventListener('change', update);
      applyBtn.addEventListener('click', () => {
        const t = normalizeDescription(tpl.value);
        const list = pending();
        app.savePrefs({ lastTemplate: tpl.value });
        app.setMany(list.map((it) => [it.key, applyTemplate(t, it)]));
        toast(`${list.length} deskripsi diisi`, 'ok');
        close();
      });
      update();
      setTimeout(() => tpl.focus(), 0);
      return [
        h('p', { class: 'muted', text: targetsAll
          ? `Tidak ada baris yang dicentang, jadi target = ${fmt(targets.length)} objek di tampilan saat ini.`
          : `Target = ${fmt(targets.length)} objek yang dicentang.` }),
        h('label', { class: 'field' }, h('span', { text: 'Teks / template' }), tpl),
        h('p', { class: 'muted small' }, 'Placeholder: ', h('code', { text: '{name}' }), ' nama objek, ', h('code', { text: '{table}' }), ' nama tabel, ', h('code', { text: '{type}' }), ' tabel/kolom/measure.'),
        h('label', { class: 'check', for: 'bulk-only-empty' }, onlyEmpty, ' Hanya isi yang masih kosong'),
        h('div', null, h('strong', { class: 'small', text: 'Pratinjau' }), preview),
        h('div', { class: 'actions' }, applyBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })),
      ];
    });
  });

  // ---------- find & replace ----------
  replaceBtn.addEventListener('click', () => {
    const doc = app.doc();
    openModal('Cari & ganti di deskripsi', (close) => {
      const find = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: 'fr-find', placeholder: 'Cari' }));
      const repl = /** @type {HTMLInputElement} */ (h('input', { type: 'text', id: 'fr-replace', placeholder: 'Ganti dengan' }));
      const cs = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'fr-case' }));
      const scope = /** @type {HTMLSelectElement} */ (h('select', { id: 'fr-scope' },
        h('option', { value: 'all', text: 'Semua objek' }),
        h('option', { value: 'view', text: 'Tampilan saat ini' }),
        h('option', { value: 'selected', text: 'Yang dicentang' })));
      const info = h('p', { class: 'muted' });
      const applyBtn = h('button', { type: 'button', class: 'btn primary', id: 'fr-apply', text: 'Ganti semua' });
      const compute = () => {
        const items = (scope.value === 'view' ? ctx.viewItems() : scope.value === 'selected' ? ctx.selectedItems() : doc.items).filter((it) => it.editable);
        const changes = [];
        let total = 0;
        for (const it of items) {
          const r = replaceAllLiteral(app.desc(it), find.value, repl.value, cs.checked);
          if (r.count) {
            total += r.count;
            changes.push([it.key, r.text]);
          }
        }
        return { changes, total };
      };
      const update = () => {
        const { changes, total } = compute();
        info.textContent = find.value ? `${fmt(total)} kemunculan di ${fmt(changes.length)} deskripsi` : 'Ketik teks yang dicari.';
        /** @type {HTMLButtonElement} */ (applyBtn).disabled = changes.length === 0;
      };
      for (const el of [find, repl, cs, scope]) el.addEventListener('input', update);
      cs.addEventListener('change', update);
      applyBtn.addEventListener('click', () => {
        const { changes, total } = compute();
        app.setMany(changes);
        toast(`${total} kemunculan diganti di ${changes.length} deskripsi`, 'ok');
        close();
      });
      update();
      setTimeout(() => find.focus(), 0);
      return [
        h('label', { class: 'field' }, h('span', { text: 'Cari' }), find),
        h('label', { class: 'field' }, h('span', { text: 'Ganti dengan' }), repl),
        h('label', { class: 'field' }, h('span', { text: 'Cakupan' }), scope),
        h('label', { class: 'check', for: 'fr-case' }, cs, ' Peka huruf besar/kecil'),
        info,
        h('div', { class: 'actions' }, applyBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })),
      ];
    });
  });

  refresh();
  return { refresh };
}

const TYPE_LABEL = { table: 'Tabel', column: 'Kolom', measure: 'Measure' };

function stat(n, label) {
  return h('div', { class: 'stat' }, h('strong', { text: fmt(n) }), h('span', { text: label }));
}

/** File name without extension, safe for downloads. */
export function baseName(name) {
  const n = name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return n || 'tmdl';
}
