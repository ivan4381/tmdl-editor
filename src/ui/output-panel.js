// Step 3: output. Writer + validator from core; diff preview; Copy / Download.

import { applyDescriptions } from '../core/writer.js';
import { validateRoundTrip } from '../core/validator.js';
import { lineDiff, toHunks, diffStats } from '../core/diff.js';
import { splitText, truncate, BOM } from '../core/text.js';
import { progress } from '../core/items.js';
import { h, clear, toast, downloadText, copyText, fmt } from './dom.js';
import { baseName } from './tools.js';

const DIFF_LINE_MAX = 2000;
const MAX_HUNKS = 300;

/**
 * Build output + validation for a document.
 * @param {any} doc
 */
export function computeOutput(doc) {
  const output = applyDescriptions(doc.parsed, doc.edits);
  const validation = validateRoundTrip(doc.text, output);
  return { output, validation, unchanged: output === doc.text };
}

/**
 * @param {any} app
 * @param {HTMLElement} root
 */
export function initOutput(app, root) {
  const body = h('div', { class: 'output-layout' });
  root.append(body);

  function render() {
    clear(body);
    const doc = app.doc();
    if (!doc) return;
    const { output, validation, unchanged } = computeOutput(doc);
    const p = progress(doc.items, doc.edits);
    const isFullModel = doc.parsed.hasModel && doc.parsed.hasCreateOrReplace;
    const outName = doc.fromFile ? doc.name : baseName(doc.name) + '.tmdl';

    // Status.
    const status = validation.ok
      ? h('div', { class: 'banner ok', id: 'validation-status' },
        h('strong', { text: '✓ Validasi lolos.' }),
        ' Hanya baris deskripsi yang berbeda dari input. ',
        unchanged ? 'Belum ada perubahan deskripsi.' : `${fmt(p.changed)} deskripsi diubah.`)
      : h('div', { class: 'banner error', id: 'validation-status' },
        h('strong', { text: '✕ Validasi gagal. Copy dan Download diblokir.' }),
        ' Ada perubahan di luar baris deskripsi. Ini bug, jadi mohon laporkan beserta contoh input.',
        h('ul', { class: 'errors' }, validation.errors.map((e) => h('li', null,
          e.line ? `Baris ${e.line}: ` : '', e.message,
          e.expected !== undefined ? h('div', { class: 'mono small' }, 'diharapkan: ', truncate(e.expected, 300)) : null,
          e.actual !== undefined ? h('div', { class: 'mono small' }, 'didapat: ', truncate(e.actual, 300)) : null))));

    const copyBtn = h('button', {
      type: 'button', class: 'btn primary', id: 'copy-btn', disabled: !validation.ok, text: 'Copy to clipboard',
      onclick: async () => {
        // The clipboard never carries a BOM; TMDL view does not need it.
        const text = output.startsWith(BOM) ? output.slice(1) : output;
        const ok = await copyText(text);
        toast(ok ? 'Script disalin. Tempel di tab baru TMDL view lalu klik Apply.' : 'Gagal menyalin. Pakai Download.', ok ? 'ok' : 'error');
      },
    });
    const dlBtn = h('button', {
      type: 'button', class: 'btn', id: 'download-btn', disabled: !validation.ok, text: 'Download .tmdl',
      onclick: () => downloadText(outName, output),
    });
    const dlOrig = h('button', {
      type: 'button', class: 'btn ghost', id: 'download-original', text: 'Download original (backup)',
      onclick: () => downloadText(baseName(doc.name) + '.original.tmdl', doc.text),
    });

    body.append(
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h1', { text: 'Output' }), h('span', { class: 'muted', text: doc.name })),
        status,
        isFullModel ? h('div', { class: 'banner warn' },
          h('strong', { text: 'Script seluruh model.' }),
          ' Apply akan menjalankan createOrReplace untuk seluruh model. Validator menjamin hanya deskripsi yang berubah, tetapi tetap simpan salinan script asli (tombol "Download original") dan simpan PBIP/commit git sebelum Apply.') : null,
        h('div', { class: 'actions' }, copyBtn, dlBtn, dlOrig),
        guide()),
    );
    body.append(diffView(doc.text, output));
    if (app.docs.length > 1) body.append(allDocs());
  }

  function guide() {
    return h('details', { class: 'guide', open: true },
      h('summary', { text: 'Cara menerapkan di Power BI Desktop' }),
      h('ol', null,
        h('li', { text: 'Simpan dulu: save sebagai PBIP atau commit git, supaya mudah kembali kalau perlu.' }),
        h('li', { text: 'Buka TMDL view, lalu buat tab baru (+).' }),
        h('li', { text: 'Tempel script hasil Copy (Ctrl+V).' }),
        h('li', { text: 'Klik Apply. Tidak ada refresh data yang dipicu.' }),
        h('li', { text: 'Cek deskripsi di Model view (panel Properties) atau dengan hover di Data pane.' })));
  }

  function diffView(original, output) {
    const a = splitText(original).lines;
    const b = splitText(output).lines;
    const ops = lineDiff(a, b);
    const st = diffStats(ops);
    const hunks = toHunks(ops, 2);
    const wrap = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', { text: 'Perubahan' }),
        h('span', { class: 'muted', id: 'diff-stats', text: `+${fmt(st.added)} / −${fmt(st.removed)} baris · ${fmt(hunks.length)} blok` })));
    if (!hunks.length) {
      wrap.append(h('p', { class: 'muted', text: 'Tidak ada perbedaan. Output identik byte-per-byte dengan input.' }));
      return wrap;
    }
    const diff = h('div', { class: 'diff', role: 'table', 'aria-label': 'Diff' });
    for (const hk of hunks.slice(0, MAX_HUNKS)) {
      const block = h('div', { class: 'hunk' });
      for (const op of hk.ops) {
        block.append(h('div', { class: 'dl ' + op.type },
          h('span', { class: 'ln', text: op.a >= 0 ? String(op.a + 1) : '' }),
          h('span', { class: 'ln', text: op.b >= 0 ? String(op.b + 1) : '' }),
          h('span', { class: 'sign', text: op.type === 'add' ? '+' : op.type === 'del' ? '−' : ' ' }),
          h('span', { class: 'code', text: truncate(op.text, DIFF_LINE_MAX) })));
      }
      diff.append(block);
    }
    wrap.append(diff);
    if (hunks.length > MAX_HUNKS) wrap.append(h('p', { class: 'muted', text: `…dan ${fmt(hunks.length - MAX_HUNKS)} blok lagi (tidak ditampilkan).` }));
    return wrap;
  }

  function allDocs() {
    const card = h('div', { class: 'card' }, h('h2', { text: 'Semua dokumen' }));
    const list = h('ul', { class: 'doc-list' });
    app.docs.forEach((d, i) => {
      const r = computeOutput(d);
      const pr = progress(d.items, d.edits);
      list.append(h('li', null,
        h('span', { class: r.validation.ok ? 'dot ok' : 'dot error' }),
        h('button', { type: 'button', class: 'link-btn', text: d.name, onclick: () => app.setActive(i) }),
        h('span', { class: 'muted', text: ` · ${fmt(pr.changed)} diubah` }),
        h('button', {
          type: 'button', class: 'btn small', text: 'Download', disabled: !r.validation.ok,
          onclick: () => downloadText(d.fromFile ? d.name : baseName(d.name) + '.tmdl', r.output),
        })));
    });
    card.append(list);
    return card;
  }

  app.on('step', (s) => {
    if (s === 'output') render();
  });
  app.on('active', () => {
    if (app.step === 'output') render();
  });
  app.on('docs', () => clear(body));
}
