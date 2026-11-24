// Step 1: paste or drop .tmdl files, parse, show summary / warnings / draft offer.

import { summarize } from '../core/items.js';
import { h, clear, toast, fmt } from './dom.js';

const PLACEHOLDER = [
  'Tempel script TMDL di sini.',
  '',
  'Dari Power BI Desktop:',
  '  1. Buka TMDL view (ikon di sisi kiri).',
  '  2. Seret node "Semantic model" (atau tabel tertentu) dari Data pane ke editor,',
  '     atau klik kanan objek → Script TMDL → Clipboard.',
  '  3. Ctrl+A lalu Ctrl+C di editor TMDL, lalu tempel (Ctrl+V) di sini.',
  '',
  'Bisa juga menyeret file .tmdl dari folder PBIP ke kotak di bawah.',
].join('\n');

/**
 * Decode a file keeping a UTF-8 BOM (FileReader.readAsText would strip it).
 * @param {File} file
 */
async function readFileKeepBom(file) {
  const buf = await file.arrayBuffer();
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
}

/**
 * @param {any} app
 * @param {HTMLElement} root
 */
export function initInput(app, root) {
  /** @type {{name:string, text:string}[]} */
  let files = [];

  const textarea = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'input-text',
    id: 'input-text',
    spellcheck: false,
    autocomplete: 'off',
    wrap: 'off',
    placeholder: PLACEHOLDER,
    'aria-label': 'Script TMDL',
  }));
  const fileInput = /** @type {HTMLInputElement} */ (h('input', { type: 'file', accept: '.tmdl,text/plain', multiple: true, hidden: true }));
  const chips = h('div', { class: 'chips' });
  const summary = h('div', { class: 'summary', id: 'input-summary' });
  const parseBtn = h('button', { class: 'btn primary', type: 'button', id: 'parse-btn', text: 'Parse' });
  const clearBtn = h('button', { class: 'btn ghost', type: 'button', text: 'Kosongkan' });

  const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Pilih atau seret file .tmdl' },
    h('strong', { text: 'Seret file .tmdl ke sini' }),
    h('span', { text: ' atau klik untuk memilih. Beberapa file sekaligus boleh; tiap file diproses dan di-output terpisah.' }),
  );

  root.append(
    h('div', { class: 'input-layout' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h1', { text: 'Tempel script TMDL' }),
          h('p', { class: 'muted', text: 'Semua proses terjadi di browser ini. Tidak ada data yang dikirim ke mana pun.' })),
        textarea,
        drop,
        fileInput,
        chips,
        h('div', { class: 'actions' }, parseBtn, clearBtn)),
      summary,
    ),
  );

  function renderChips() {
    clear(chips);
    for (const f of files) {
      chips.append(h('span', { class: 'chip' },
        f.name,
        h('button', {
          type: 'button', class: 'chip-x', 'aria-label': 'Hapus ' + f.name, text: '×',
          onclick: () => {
            files = files.filter((x) => x !== f);
            renderChips();
          },
        })));
    }
  }

  async function addFiles(list) {
    for (const file of list) {
      if (!/\.tmdl$/i.test(file.name) && file.type && !file.type.startsWith('text/')) {
        toast(`${file.name} dilewati (bukan file teks/.tmdl)`, 'error');
        continue;
      }
      try {
        const text = await readFileKeepBom(file);
        files = files.filter((f) => f.name !== file.name);
        files.push({ name: file.name, text });
      } catch {
        toast(`Gagal membaca ${file.name}`, 'error');
      }
    }
    renderChips();
  }

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener('change', () => {
    addFiles([...(fileInput.files || [])]);
    fileInput.value = '';
  });
  for (const el of [drop, textarea]) {
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        drop.classList.add('over');
      }
    });
    el.addEventListener('dragleave', () => drop.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      drop.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    });
  }
  // Prevent the browser from navigating to a file dropped outside the zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    files = [];
    renderChips();
    textarea.focus();
  });

  parseBtn.addEventListener('click', () => {
    const sources = [];
    if (textarea.value.trim() !== '') sources.push({ name: 'Script (tempel)', text: textarea.value, fromFile: false });
    for (const f of files) sources.push({ name: f.name, text: f.text, fromFile: true });
    if (sources.length === 0) {
      toast('Tempel script atau pilih file .tmdl dulu.', 'error');
      textarea.focus();
      return;
    }
    app.loadDocs(sources);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      parseBtn.click();
    }
  });

  function renderSummary() {
    clear(summary);
    if (!app.docs.length) return;
    let anyObjects = false;
    for (const doc of app.docs) {
      const c = summarize(doc.parsed);
      if (doc.parsed.objects.length) anyObjects = true;
      const card = h('div', { class: 'card summary-card' },
        h('div', { class: 'summary-title' },
          h('strong', { text: doc.name }),
          doc.parsed.hasModel && doc.parsed.hasCreateOrReplace ? h('span', { class: 'tag warn', text: 'script seluruh model' }) : null,
          doc.parsed.hasBom ? h('span', { class: 'tag', text: 'BOM' }) : null,
          h('span', { class: 'tag', text: doc.parsed.eol === '\r\n' ? 'CRLF' : 'LF' }),
          h('span', { class: 'tag', text: fmt(doc.parsed.lines.length) + ' baris' })),
        h('p', { class: 'summary-counts' },
          `${fmt(c.table)} tabel, ${fmt(c.column)} kolom, ${fmt(c.measure)} measure, ${fmt(c.withDesc)} deskripsi sudah ada` + (c.mQueries ? ` · ${fmt(c.mQueries)} query Power Query` : '')),
      );
      if (doc.parsed.warnings.length) {
        card.append(h('ul', { class: 'warnings' },
          doc.parsed.warnings.map((w) => h('li', null, w.line ? `Baris ${w.line + 1}: ` : '', w.message))));
      }
      if (doc.draft) card.append(draftBanner(doc));
      summary.append(card);
    }
    if (anyObjects) {
      summary.append(h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', id: 'goto-edit', text: 'Lanjut ke Edit →', onclick: () => app.goto('edit') })));
    }
  }

  function draftBanner(doc) {
    const d = doc.draft;
    const when = new Date(d.savedAt).toLocaleString('id-ID');
    return h('div', { class: 'banner info draft-banner' },
      h('span', null, `Ada draft tersimpan untuk input ini (${fmt(d.edits.length)} perubahan, ${when}). Kalau Anda langsung mengedit tanpa memulihkan, draft lama akan ditimpa.`),
      h('span', { class: 'banner-actions' },
        h('button', {
          class: 'btn small primary', type: 'button', text: 'Pulihkan',
          onclick: () => {
            const n = app.restoreDraft(doc);
            toast(`${n} deskripsi dipulihkan dari draft`, 'ok');
          },
        }),
        h('button', { class: 'btn small ghost', type: 'button', text: 'Abaikan', onclick: () => app.discardDraft(doc) })));
  }

  app.on('docs', () => {
    renderSummary();
    const total = app.docs.reduce((n, d) => n + d.parsed.objects.length, 0);
    if (total === 0) toast('Tidak ada table/column/measure yang dikenali.', 'error');
  });
  app.on('draft', renderSummary);
}
