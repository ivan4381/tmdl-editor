// AI description suggestions (opt-in, BYOK): settings, consent, per-object ✨
// and bulk fill with progress / cancel. Network calls live in ../ai/providers.js,
// prompt building and parsing in ../core/ai-prompt.js.

import { listModels, defaultModel, chatJson, providerOf, AiError, SCHEMAS } from '../ai/providers.js';

const PROVIDER_NAME = { gemini: 'Gemini', claude: 'Claude', copilotku: 'Copilotku' };
import { systemPrompt, buildUserMessage, parseSuggestions, makeBatches, mSystemPrompt, buildMUserMessage, parseMSuggestions } from '../core/ai-prompt.js';
import { normalizeDescription } from '../core/writer.js';
import { refactorSystemPrompt, buildRefactorMessage, parseRefactorResponse, unmask, analyzeRefactor } from '../core/refactor.js';
import { truncate } from '../core/text.js';
import { h, $, clear, toast, openModal, fmt } from './dom.js';
import { loadAiKeys, saveAiKeys } from './storage.js';

const CONCURRENCY = 2;
const FATAL = new Set(['auth', 'forbidden', 'model']);

/**
 * @param {any} app
 * @param {{viewItems:()=>any[], selectedItems:()=>any[]}} ctx
 */
export function initAi(app, ctx) {
  const saved = loadAiKeys();
  const ai = {
    keys: saved.keys,
    remember: saved.remember,
    /** @type {{id:string, label:string, provider:string}[]} */
    models: Array.isArray(app.prefs.aiModels) ? app.prefs.aiModels : [],
    model: app.prefs.aiModel || '',
    lang: app.prefs.aiLang === 'en' ? 'en' : 'id',
    context: app.prefs.aiContext || '',
    maskM: !!app.prefs.aiMaskM,
    consent: !!app.prefs.aiConsent,
    running: false,
    /** token usage since the page was opened */
    usage: { input: 0, output: 0, requests: 0 },
  };

  // Keep the shared dialog open while a bulk run is in progress.
  const dlg = /** @type {HTMLDialogElement} */ ($('#modal'));
  dlg.addEventListener('cancel', (e) => {
    if (ai.running) e.preventDefault();
  });

  /** Add one reply's token usage to the session total (and an optional accumulator). */
  const track = (res, acc) => {
    const u = { input: res.inputTokens || 0, output: res.outputTokens || 0 };
    for (const t of acc ? [ai.usage, acc] : [ai.usage]) {
      t.input += u.input;
      t.output += u.output;
      t.requests = (t.requests || 0) + 1;
    }
    return u;
  };
  /** "1.234 token (masuk 1.100 · keluar 134)" */
  const formatUsage = (u) => (!u.input && !u.output
    ? 'jumlah token tidak dilaporkan provider'
    : `${fmt(u.input + u.output)} token (masuk ${fmt(u.input)} · keluar ${fmt(u.output)})`);

  const hasKey = () => !!(ai.keys.gemini || ai.keys.claude || ai.keys.copilotku);
  const modelLabel = () => {
    const m = ai.models.find((x) => x.id === ai.model);
    return m ? `${m.label} (${PROVIDER_NAME[m.provider] || m.provider})` : ai.model;
  };
  const ready = () => ai.consent && hasKey() && !!ai.model && !!ai.keys[providerOf(ai.model)];

  // ---------- settings ----------
  function openSettings(onSaved) {
    openModal('Pengaturan AI', (close) => {
      const consent = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'ai-consent' }));
      consent.checked = ai.consent;
      const gKey = keyInput('ai-key-gemini', ai.keys.gemini, 'AIza…');
      const cKey = keyInput('ai-key-claude', ai.keys.claude, 'sk-ant-…');
      const kKey = keyInput('ai-key-copilotku', ai.keys.copilotku, 'sk-…');
      const remember = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'ai-remember' }));
      remember.checked = ai.remember;
      const modelSel = /** @type {HTMLSelectElement} */ (h('select', { id: 'ai-model' }));
      const modelInfo = h('span', { class: 'muted small' });
      const loadBtn = h('button', { type: 'button', class: 'btn small', text: 'Muat daftar model' });
      const lang = /** @type {HTMLSelectElement} */ (h('select', { id: 'ai-lang' },
        h('option', { value: 'id', text: 'Bahasa Indonesia' }),
        h('option', { value: 'en', text: 'English' })));
      lang.value = ai.lang;
      const context = /** @type {HTMLTextAreaElement} */ (h('textarea', {
        id: 'ai-context', class: 'tpl', rows: 3,
        placeholder: 'Opsional. Contoh: Model monitoring penyaluran LPG dari terminal ke SPBE. MOR = Marketing Operation Region.',
      }));
      context.value = ai.context;
      const maskM = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'ai-mask-m' }));
      maskM.checked = ai.maskM;
      const err = h('div', { class: 'banner error', hidden: true });

      let current = ai.models;
      const fillModels = (models, selected) => {
        current = models;
        clear(modelSel);
        if (!models.length) {
          modelSel.append(h('option', { value: '', text: 'Isi API key lalu klik "Muat daftar model"' }));
          return;
        }
        for (const [prov, label] of [['gemini', 'Google Gemini'], ['claude', 'Anthropic Claude'], ['copilotku', 'Copilotku']]) {
          const list = models.filter((m) => m.provider === prov);
          if (!list.length) continue;
          modelSel.append(h('optgroup', { label }, list.map((m) => h('option', { value: m.id, title: m.id, text: `${m.label} (${PROVIDER_NAME[m.provider] || m.provider})` }))));
        }
        modelSel.value = models.some((m) => m.id === selected) ? selected : defaultModel(models) || '';
      };
      fillModels(ai.models, ai.model);

      const load = async () => {
        const keys = { gemini: gKey.value.trim(), claude: cKey.value.trim(), copilotku: kKey.value.trim() };
        if (!keys.gemini && !keys.claude && !keys.copilotku) {
          showErr('Isi minimal satu API key (Gemini, Claude, atau Copilotku).');
          return null;
        }
        err.hidden = true;
        loadBtn.disabled = true;
        modelInfo.textContent = 'Memuat model…';
        try {
          const { models, errors } = await listModels(keys);
          fillModels(models, modelSel.value || ai.model);
          modelInfo.textContent = models.length ? `${fmt(models.length)} model tersedia.` : '';
          if (errors.length) showErr(errors.join(' '));
          return models;
        } finally {
          loadBtn.disabled = false;
        }
      };
      loadBtn.addEventListener('click', () => {
        load();
      });
      function showErr(msg) {
        err.textContent = msg;
        err.hidden = false;
      }

      const saveBtn = h('button', { type: 'button', class: 'btn primary', id: 'ai-save', text: 'Simpan' });
      saveBtn.addEventListener('click', async () => {
        if (!consent.checked) {
          showErr('Centang persetujuan pengiriman data dulu untuk memakai fitur AI.');
          return;
        }
        let models = current;
        if (!models.length) {
          const loaded = await load();
          if (!loaded || !loaded.length) return;
          models = loaded;
        }
        const model = modelSel.value;
        const keys = { gemini: gKey.value.trim() || undefined, claude: cKey.value.trim() || undefined, copilotku: kKey.value.trim() || undefined };
        if (!model) {
          showErr('Pilih model.');
          return;
        }
        if (!keys[providerOf(model)]) {
          showErr(`Model ${model} butuh API key ${PROVIDER_NAME[providerOf(model)]}.`);
          return;
        }
        Object.assign(ai, { keys, remember: remember.checked, models, model, lang: /** @type {any} */ (lang.value), context: context.value, maskM: maskM.checked, consent: true });
        saveAiKeys(keys, remember.checked);
        app.savePrefs({ aiModels: models, aiModel: model, aiLang: ai.lang, aiContext: ai.context, aiMaskM: ai.maskM, aiConsent: true });
        close();
        toast('Pengaturan AI disimpan · ' + modelLabel(), 'ok');
        app.emit('aisettings');
        if (onSaved) onSaved();
      });

      return [
        h('div', { class: 'banner warn ai-notice' },
          h('strong', { text: 'Data akan dikirim ke penyedia AI. ' }),
          'Saat Anda menekan ✨, nama tabel/kolom/measure, ekspresi DAX/M, deskripsi yang sudah ada, dan konteks bisnis untuk objek tersebut dikirim ke Google (Gemini), Anthropic (Claude), atau Copilotku (lewat proxy Cloudflare Worker batik-copilotku-proxy yang hanya meneruskan, tanpa menyimpan) memakai API key Anda sendiri. ',
          'Untuk Power Query, kode M query yang diminta ikut dikirim (bisa berisi nama server, URL, dan path; gunakan opsi sensor di bawah). ',
          'Tidak ada yang dikirim sebelum tombol ✨ ditekan, dan sisa script tidak pernah dikirim. Pastikan kebijakan data organisasi Anda mengizinkannya.'),
        h('label', { class: 'check', for: 'ai-consent' }, consent, ' Saya mengerti dan setuju data objek dikirim ke penyedia AI yang saya pilih'),
        h('label', { class: 'field' }, h('span', { text: 'Google Gemini API key' }), gKey),
        h('label', { class: 'field' }, h('span', { text: 'Anthropic Claude API key' }), cKey),
        h('label', { class: 'field' }, h('span', { text: 'Copilotku API key (app key disarankan)' }), kKey),
        h('label', { class: 'check', for: 'ai-remember' }, remember, ' Ingat key di browser ini (tanpa centang: hilang saat tab ditutup)'),
        h('div', { class: 'field' }, h('span', { text: 'Model' }), h('div', { class: 'row-inline' }, modelSel, loadBtn), modelInfo),
        h('label', { class: 'field' }, h('span', { text: 'Bahasa deskripsi' }), lang),
        h('label', { class: 'check', for: 'ai-mask-m' }, maskM, ' Sensor URL, server, path, dan email di kode M sebelum dikirim (diganti placeholder seperti <URL_1>)'),
        h('label', { class: 'field' }, h('span', { text: 'Konteks bisnis (opsional, ikut dikirim)' }), context),
        err,
        ai.usage.requests ? h('p', { class: 'muted small', id: 'ai-session-usage' },
          `Pemakaian token sejak halaman dibuka: ${formatUsage(ai.usage)} · ${fmt(ai.usage.requests)} permintaan`) : '',
        h('div', { class: 'actions' }, saveBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })),
      ];
    });
  }

  function keyInput(id, value, placeholder) {
    const el = /** @type {HTMLInputElement} */ (h('input', { type: 'password', id, autocomplete: 'off', spellcheck: false, placeholder }));
    el.value = value || '';
    return el;
  }

  /** Make sure settings are complete; opens the settings dialog otherwise. */
  function ensureReady(then) {
    if (ready()) return true;
    openSettings(then);
    return false;
  }

  // ---------- core run ----------
  /**
   * Ask the model for one batch. Retries once on rate/busy errors.
   * @returns {Promise<{suggestions:Map<string,string>, missing:string[]}>}
   */
  async function askBatch(batch, signal) {
    const doc = app.doc();
    const { user, ids } = buildUserMessage(batch, { tables: doc.tables, descOf: (it) => app.desc(it, doc), businessContext: ai.context });
    const system = systemPrompt(ai.lang);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await chatJson(ai.keys, ai.model, system, user, { signal, maxTokens: Math.min(16000, 400 + batch.length * 220), schema: SCHEMAS.descriptions });
        return { ...parseSuggestions(res.text, ids), usage: track(res) };
      } catch (e) {
        if (attempt === 0 && e instanceof AiError && (e.kind === 'rate' || e.kind === 'busy') && !(signal && signal.aborted)) {
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        throw e;
      }
    }
  }

  function markAi(doc, key, text) {
    doc.aiFilled.set(key, normalizeDescription(text));
  }

  // ---------- per object ✨ ----------
  async function confirmOverwrite(item, current) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (v, close) => {
        answered = true;
        close();
        resolve(v);
      };
      openModal('Timpa deskripsi?', (close) => {
        dlg.addEventListener('close', () => {
          if (!answered) resolve(false);
        }, { once: true });
        return [
          h('p', null, h('strong', { text: item.label || `${item.table} › ${item.name}` }), ' sudah punya deskripsi:'),
          h('blockquote', { class: 'quote', text: truncate(current, 600) }),
          h('p', { text: 'Ganti dengan saran AI? Anda tetap bisa membatalkannya dengan tombol ↺ atau Esc di sel.' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn primary', id: 'ai-confirm-overwrite', text: 'Ya, timpa', onclick: () => done(true, close) }),
            h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: () => done(false, close) })),
        ];
      });
    });
  }

  /**
   * @param {any} item
   * @param {HTMLButtonElement} btn
   */
  async function suggestOne(item, btn) {
    if (!item.editable) return;
    if (!ensureReady(() => suggestOne(item, btn))) return;
    const doc = app.doc();
    const current = normalizeDescription(app.desc(item, doc));
    if (current && !(await confirmOverwrite(item, current))) return;
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const { suggestions, usage } = await askBatch([item]);
      const text = suggestions.get(item.key);
      if (!text) {
        toast('AI tidak mengembalikan saran untuk objek ini. Coba lagi atau pilih model lain.', 'error');
        return;
      }
      if (app.doc() !== doc) return;
      markAi(doc, item.key, text);
      app.setDesc(item.key, text, {}, doc);
      toast('Saran AI diisi · ' + formatUsage(usage), 'ok');
    } catch (e) {
      toast(e instanceof AiError ? e.message : 'Gagal meminta saran AI: ' + (e && e.message), 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  // ---------- bulk ----------
  function openBulk() {
    if (!ensureReady(openBulk)) return;
    const doc = app.doc();
    const selected = ctx.selectedItems();
    openModal('Isi deskripsi dengan AI', (close) => {
      const scope = /** @type {HTMLSelectElement} */ (h('select', { id: 'ai-scope' },
        h('option', { value: 'all', text: `Semua objek (${fmt(doc.items.filter((i) => i.editable).length)})` }),
        h('option', { value: 'view', text: `Tampilan saat ini (${fmt(ctx.viewItems().filter((i) => i.editable).length)})` }),
        selected.length ? h('option', { value: 'selected', text: `Yang dicentang (${fmt(selected.length)})` }) : null));
      const modeEmpty = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'ai-mode', id: 'ai-mode-empty', value: 'empty' }));
      const modeAll = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'ai-mode', id: 'ai-mode-all', value: 'all' }));
      modeEmpty.checked = true;
      const summary = h('p', { class: 'ai-summary' });
      const startBtn = h('button', { type: 'button', class: 'btn primary', id: 'ai-start' });
      const body = h('div');

      const targets = () => {
        const base = scope.value === 'view' ? ctx.viewItems() : scope.value === 'selected' ? ctx.selectedItems() : doc.items;
        const editable = base.filter((it) => it.editable);
        return modeEmpty.checked ? editable.filter((it) => normalizeDescription(app.desc(it, doc)) === '') : editable;
      };
      const update = () => {
        const list = targets();
        const overwrite = list.filter((it) => normalizeDescription(app.desc(it, doc)) !== '').length;
        clear(summary);
        if (!list.length) {
          summary.append(modeEmpty.checked
            ? 'Saat ini semua objek di cakupan ini sudah memiliki deskripsi.'
            : 'Tidak ada objek yang bisa diisi di cakupan ini.');
        } else {
          summary.append(h('strong', { text: `${fmt(list.length)} objek` }), ' akan diisi');
          if (overwrite) summary.append(h('span', { class: 'warn-text', text: ` (${fmt(overwrite)} di antaranya sudah punya deskripsi dan akan ditimpa)` }));
          summary.append('.');
        }
        startBtn.textContent = `Mulai (${fmt(list.length)} objek)`;
        /** @type {HTMLButtonElement} */ (startBtn).disabled = list.length === 0;
      };
      for (const el of [scope, modeEmpty, modeAll]) el.addEventListener('change', update);

      startBtn.addEventListener('click', () => {
        const list = targets();
        const overwrite = list.filter((it) => normalizeDescription(app.desc(it, doc)) !== '');
        if (overwrite.length) confirmStep(list, overwrite);
        else runStep(list);
      });

      function optionsStep() {
        clear(body);
        body.append(
          h('label', { class: 'field' }, h('span', { text: 'Cakupan' }), scope),
          h('div', { class: 'field' }, h('span', { text: 'Yang diisi' }),
            h('label', { class: 'check', for: 'ai-mode-empty' }, modeEmpty, ' Hanya yang masih kosong'),
            h('label', { class: 'check', for: 'ai-mode-all' }, modeAll, ' Semua objek (timpa deskripsi yang sudah ada)')),
          summary,
          h('p', { class: 'muted small' }, 'Model: ', h('strong', { text: modelLabel() }), ' · ',
            h('button', { type: 'button', class: 'link-btn', text: 'ubah pengaturan AI', onclick: () => openSettings(openBulk) })),
          h('div', { class: 'actions' }, startBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })));
        update();
      }

      function confirmStep(list, overwrite) {
        clear(body);
        body.append(
          h('div', { class: 'banner warn' },
            h('strong', { text: `${fmt(overwrite.length)} deskripsi yang sudah terisi akan ditimpa dengan saran AI.` }),
            ' Deskripsi asli dari script tetap bisa dikembalikan per sel dengan tombol ↺, tetapi isian yang belum disimpan akan hilang.'),
          h('ul', { class: 'small-list' },
            overwrite.slice(0, 8).map((it) => h('li', null, h('strong', { text: `${it.table} › ${it.name}: ` }), truncate(normalizeDescription(app.desc(it, doc)), 120))),
            overwrite.length > 8 ? h('li', { class: 'muted', text: `…dan ${fmt(overwrite.length - 8)} lagi` }) : null),
          h('p', { text: 'Lanjutkan?' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn primary', id: 'ai-confirm-bulk', text: `Ya, timpa ${fmt(overwrite.length)} deskripsi`, onclick: () => runStep(list) }),
            h('button', { type: 'button', class: 'btn ghost', text: 'Kembali', onclick: optionsStep })));
      }

      async function runStep(list) {
        const ctrl = new AbortController();
        const snapshot = new Map(list.map((it) => [it.key, normalizeDescription(app.desc(it, doc))]));
        const batches = makeBatches(list);
        let done = 0;
        let filled = 0;
        let failed = 0;
        let skipped = 0;
        const runUsage = { input: 0, output: 0, requests: 0 };
        const errors = new Set();
        const bar = h('span');
        const status = h('p', { class: 'ai-progress-text', id: 'ai-progress' });
        const cancelBtn = h('button', { type: 'button', class: 'btn', text: 'Batalkan', onclick: () => ctrl.abort() });
        clear(body);
        body.append(h('div', { class: 'progress-bar wide' }, bar), status, h('div', { class: 'actions' }, cancelBtn));
        const paint = () => {
          bar.style.width = (list.length ? (done / list.length) * 100 : 100) + '%';
          status.textContent = `${fmt(done)}/${fmt(list.length)} objek diproses · ${fmt(filled)} terisi` + (failed ? ` · ${fmt(failed)} gagal` : '');
        };
        paint();
        ai.running = true;
        let next = 0;
        const worker = async () => {
          while (next < batches.length && !ctrl.signal.aborted) {
            const batch = batches[next++];
            try {
              const { suggestions, missing, usage } = await askBatch(batch, ctrl.signal);
              runUsage.input += usage.input;
              runUsage.output += usage.output;
              runUsage.requests++;
              const pairs = [];
              for (const [key, text] of suggestions) {
                // Never overwrite something the user changed while the run was going.
                if (normalizeDescription(app.desc(doc.byKey.get(key), doc)) !== snapshot.get(key)) {
                  skipped++;
                  continue;
                }
                markAi(doc, key, text);
                pairs.push([key, text]);
              }
              if (pairs.length) app.setMany(pairs, doc);
              filled += pairs.length;
              failed += missing.length;
              if (missing.length) errors.add('Sebagian objek tidak mendapat saran dari AI.');
            } catch (e) {
              if (ctrl.signal.aborted) break;
              failed += batch.length;
              errors.add(e instanceof AiError ? e.message : String(e && e.message));
              if (e instanceof AiError && FATAL.has(e.kind)) ctrl.abort();
            }
            done += batch.length;
            paint();
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
        ai.running = false;
        const cancelled = ctrl.signal.aborted && done < list.length;
        clear(body);
        body.append(
          h('div', { class: filled ? 'banner ok' : 'banner warn' },
            h('strong', { text: `${fmt(filled)} deskripsi diisi AI.` }),
            cancelled ? ' Proses dihentikan sebelum selesai.' : '',
            skipped ? ` ${fmt(skipped)} dilewati karena Anda mengubahnya selama proses.` : '',
            failed ? ` ${fmt(failed)} objek gagal.` : ''),
          h('p', { class: 'muted small', id: 'ai-usage' }, 'Pemakaian token: ' + formatUsage(runUsage) + ` · ${fmt(runUsage.requests)} permintaan`),
          h('ul', { class: 'small-list', hidden: errors.size === 0 }, [...errors].map((m) => h('li', { text: m }))),
          h('p', { class: 'muted', text: 'Saran AI ditandai ✨ di grid. Periksa dan sunting bila perlu sebelum Copy ke Power BI. Filter "Diubah" menampilkan semua yang berubah.' }),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', id: 'ai-done', text: 'Tutup', onclick: close })));
      }

      optionsStep();
      return body;
    });
  }

  // ---------- Power Query (M) ----------
  /**
   * Ask the model for one query. Retries once on rate/busy errors.
   * @param {import('../core/mquery.js').MQuery} query
   * @param {{wantQueryDesc:boolean, stepKeys:Set<string>}} want
   */
  async function askM(query, want, signal) {
    const doc = app.doc();
    const { user, ids } = buildMUserMessage(query, {
      descOf: (key) => {
        const e = app.entry(key, doc);
        return e ? app.desc(e, doc) : '';
      },
      businessContext: ai.context,
      mask: ai.maskM,
      wantQueryDesc: want.wantQueryDesc,
      stepKeys: want.stepKeys,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await chatJson(ai.keys, ai.model, mSystemPrompt(ai.lang), user, { signal, maxTokens: Math.min(16000, 600 + want.stepKeys.size * 160), schema: SCHEMAS.mquery });
        return { ...parseMSuggestions(res.text, ids), usage: track(res) };
      } catch (e) {
        if (attempt === 0 && e instanceof AiError && (e.kind === 'rate' || e.kind === 'busy') && !(signal && signal.aborted)) {
          await new Promise((r) => setTimeout(r, 4000));
          continue;
        }
        throw e;
      }
    }
  }

  const queryLabel = (q) => (q.kind === 'partition' ? q.table + (q.name !== q.table ? ' (' + q.name + ')' : '') : q.name);

  /**
   * ✨ for one field of a query: its description (target 'query') or one step.
   * @param {import('../core/mquery.js').MQuery} query
   * @param {{kind:'query'}|{kind:'step', step:import('../core/mquery.js').MStep}} target
   * @param {HTMLButtonElement} btn
   */
  async function suggestM(query, target, btn) {
    if (!ensureReady(() => suggestM(query, target, btn))) return;
    const doc = app.doc();
    const key = target.kind === 'query' ? query.descKey : target.step.key;
    const entry = app.entry(key, doc);
    if (!entry || !entry.editable) return;
    const current = normalizeDescription(app.desc(entry, doc));
    const label = target.kind === 'query' ? `Deskripsi query ${queryLabel(query)}` : `${queryLabel(query)} › ${target.step.name}`;
    if (current && !(await confirmOverwrite({ label }, current))) return;
    btn.disabled = true;
    btn.classList.add('busy');
    try {
      const res = await askM(query, target.kind === 'query'
        ? { wantQueryDesc: true, stepKeys: new Set() }
        : { wantQueryDesc: false, stepKeys: new Set([key]) });
      const text = target.kind === 'query' ? res.queryDescription : res.steps.get(key);
      if (!text) {
        toast('AI tidak mengembalikan saran. Coba lagi atau pilih model lain.', 'error');
        return;
      }
      if (app.doc() !== doc) return;
      markAi(doc, key, text);
      app.setDesc(key, text, {}, doc);
      toast('Saran AI diisi · ' + formatUsage(res.usage), 'ok');
    } catch (e) {
      toast(e instanceof AiError ? e.message : 'Gagal meminta saran AI: ' + (e && e.message), 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }

  /**
   * Fill query descriptions and step descriptions for many queries.
   * @param {{current?:import('../core/mquery.js').MQuery}} [opt]
   */
  function openBulkM(opt = {}) {
    if (!ensureReady(() => openBulkM(opt))) return;
    const doc = app.doc();
    openModal('Isi deskripsi Power Query dengan AI', (close) => {
      const scope = /** @type {HTMLSelectElement} */ (h('select', { id: 'aim-scope' },
        h('option', { value: 'all', text: `Semua query (${fmt(doc.queries.length)})` }),
        opt.current ? h('option', { value: 'current', text: `Query ini: ${queryLabel(opt.current)}` }) : null));
      if (opt.current) scope.value = 'current';
      const modeEmpty = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'aim-mode', id: 'aim-mode-empty' }));
      const modeAll = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'aim-mode', id: 'aim-mode-all' }));
      modeEmpty.checked = true;
      const incQuery = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', id: 'aim-inc-query' }));
      incQuery.checked = true;
      const summary = h('p', { class: 'ai-summary' });
      const startBtn = h('button', { type: 'button', class: 'btn primary', id: 'aim-start' });
      const body = h('div');

      const isEmpty = (key) => {
        const e = app.entry(key, doc);
        return !e || normalizeDescription(app.desc(e, doc)) === '';
      };
      const editable = (key) => {
        const e = app.entry(key, doc);
        return !!e && e.editable;
      };
      /** @returns {{query:any, wantQueryDesc:boolean, stepKeys:Set<string>}[]} */
      const plan = () => {
        const qs = scope.value === 'current' && opt.current ? [opt.current] : doc.queries;
        const out = [];
        for (const q of qs) {
          const wantQueryDesc = incQuery.checked && editable(q.descKey) && (!modeEmpty.checked || isEmpty(q.descKey));
          const stepKeys = new Set(q.steps.filter((st) => st.commentable && (!modeEmpty.checked || isEmpty(st.key))).map((st) => st.key));
          if (wantQueryDesc || stepKeys.size) out.push({ query: q, wantQueryDesc, stepKeys });
        }
        return out;
      };
      const allKeys = (p) => p.flatMap((x) => [...(x.wantQueryDesc ? [x.query.descKey] : []), ...x.stepKeys]);
      const update = () => {
        const p = plan();
        const keys = allKeys(p);
        const overwrite = keys.filter((k) => !isEmpty(k)).length;
        const steps = p.reduce((n, x) => n + x.stepKeys.size, 0);
        const qd = p.filter((x) => x.wantQueryDesc).length;
        clear(summary);
        if (!keys.length) {
          summary.append(modeEmpty.checked
            ? 'Saat ini semua query dan step di cakupan ini sudah memiliki deskripsi.'
            : 'Tidak ada yang bisa diisi di cakupan ini.');
        } else {
          summary.append(h('strong', { text: `${fmt(steps)} step` }), ` dan `, h('strong', { text: `${fmt(qd)} deskripsi query` }), ` di ${fmt(p.length)} query akan diisi`);
          if (overwrite) summary.append(h('span', { class: 'warn-text', text: ` (${fmt(overwrite)} sudah punya deskripsi dan akan ditimpa)` }));
          summary.append('.');
        }
        startBtn.textContent = `Mulai (${fmt(keys.length)})`;
        /** @type {HTMLButtonElement} */ (startBtn).disabled = keys.length === 0;
      };
      for (const el of [scope, modeEmpty, modeAll, incQuery]) el.addEventListener('change', update);

      startBtn.addEventListener('click', () => {
        const p = plan();
        const overwrite = allKeys(p).filter((k) => !isEmpty(k));
        if (overwrite.length) confirmStep(p, overwrite);
        else runStep(p);
      });

      function optionsStep() {
        clear(body);
        body.append(
          h('label', { class: 'field' }, h('span', { text: 'Cakupan' }), scope),
          h('div', { class: 'field' }, h('span', { text: 'Yang diisi' }),
            h('label', { class: 'check', for: 'aim-mode-empty' }, modeEmpty, ' Hanya yang masih kosong'),
            h('label', { class: 'check', for: 'aim-mode-all' }, modeAll, ' Semua (timpa deskripsi yang sudah ada)'),
            h('label', { class: 'check', for: 'aim-inc-query' }, incQuery, ' Termasuk deskripsi query (untuk query tabel = deskripsi tabel)')),
          summary,
          h('p', { class: 'muted small' }, 'Model: ', h('strong', { text: modelLabel() }), ai.maskM ? ' · URL/server/path disensor' : ' · kode M dikirim tanpa sensor', ' · ',
            h('button', { type: 'button', class: 'link-btn', text: 'ubah pengaturan AI', onclick: () => openSettings(() => openBulkM(opt)) })),
          h('div', { class: 'actions' }, startBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })));
        update();
      }

      function confirmStep(p, overwrite) {
        clear(body);
        body.append(
          h('div', { class: 'banner warn' },
            h('strong', { text: `${fmt(overwrite.length)} deskripsi yang sudah terisi akan ditimpa dengan saran AI.` }),
            ' Deskripsi asli dari script tetap bisa dikembalikan per baris dengan tombol ↺.'),
          h('p', { text: 'Lanjutkan?' }),
          h('div', { class: 'actions' },
            h('button', { type: 'button', class: 'btn primary', id: 'aim-confirm', text: `Ya, timpa ${fmt(overwrite.length)} deskripsi`, onclick: () => runStep(p) }),
            h('button', { type: 'button', class: 'btn ghost', text: 'Kembali', onclick: optionsStep })));
      }

      async function runStep(p) {
        const ctrl = new AbortController();
        const keys = allKeys(p);
        const snapshot = new Map(keys.map((k) => [k, normalizeDescription(app.desc(app.entry(k, doc), doc))]));
        let doneQ = 0;
        let filled = 0;
        let failed = 0;
        let skipped = 0;
        const runUsage = { input: 0, output: 0, requests: 0 };
        const errors = new Set();
        const bar = h('span');
        const status = h('p', { class: 'ai-progress-text', id: 'aim-progress' });
        clear(body);
        body.append(h('div', { class: 'progress-bar wide' }, bar), status,
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', text: 'Batalkan', onclick: () => ctrl.abort() })));
        const paint = () => {
          bar.style.width = (p.length ? (doneQ / p.length) * 100 : 100) + '%';
          status.textContent = `${fmt(doneQ)}/${fmt(p.length)} query diproses · ${fmt(filled)} terisi` + (failed ? ` · ${fmt(failed)} gagal` : '');
        };
        paint();
        ai.running = true;
        let next = 0;
        const worker = async () => {
          while (next < p.length && !ctrl.signal.aborted) {
            const item = p[next++];
            try {
              const res = await askM(item.query, item, ctrl.signal);
              runUsage.input += res.usage.input;
              runUsage.output += res.usage.output;
              runUsage.requests++;
              const pairs = [];
              const take = (key, text) => {
                if (!text) return false;
                if (normalizeDescription(app.desc(app.entry(key, doc), doc)) !== snapshot.get(key)) {
                  skipped++;
                  return true;
                }
                markAi(doc, key, text);
                pairs.push([key, text]);
                return true;
              };
              if (item.wantQueryDesc && !take(item.query.descKey, res.queryDescription)) failed++;
              for (const k of item.stepKeys) if (!take(k, res.steps.get(k))) failed++;
              if (pairs.length) app.setMany(pairs, doc);
              filled += pairs.length;
              if (res.missing.length || (item.wantQueryDesc && !res.queryDescription)) errors.add('Sebagian step/query tidak mendapat saran dari AI.');
            } catch (e) {
              if (ctrl.signal.aborted) break;
              failed += item.stepKeys.size + (item.wantQueryDesc ? 1 : 0);
              errors.add(e instanceof AiError ? e.message : String(e && e.message));
              if (e instanceof AiError && FATAL.has(e.kind)) ctrl.abort();
            }
            doneQ++;
            paint();
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, p.length) }, worker));
        ai.running = false;
        const cancelled = ctrl.signal.aborted && doneQ < p.length;
        clear(body);
        body.append(
          h('div', { class: filled ? 'banner ok' : 'banner warn' },
            h('strong', { text: `${fmt(filled)} deskripsi diisi AI.` }),
            cancelled ? ' Proses dihentikan sebelum selesai.' : '',
            skipped ? ` ${fmt(skipped)} dilewati karena Anda mengubahnya selama proses.` : '',
            failed ? ` ${fmt(failed)} gagal.` : ''),
          h('p', { class: 'muted small', id: 'aim-usage' }, 'Pemakaian token: ' + formatUsage(runUsage) + ` · ${fmt(runUsage.requests)} permintaan`),
          h('ul', { class: 'small-list', hidden: errors.size === 0 }, [...errors].map((m) => h('li', { text: m }))),
          h('p', { class: 'muted', text: 'Saran AI ditandai ✨. Periksa dan sunting bila perlu sebelum Copy ke Power BI.' }),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', id: 'aim-done', text: 'Tutup', onclick: close })));
      }

      optionsStep();
      return body;
    });
  }

  // ---------- Power Query refactor (separate artefact, never written to TMDL) ----------
  /**
   * @param {import('../core/mquery.js').MQuery} query
   * @param {'id'|'en'} lang
   * @param {AbortSignal} signal
   */
  async function runRefactor(query, lang, signal) {
    const doc = app.doc();
    const { user, restore } = buildRefactorMessage(query, { mask: ai.maskM, businessContext: ai.context });
    const res = await chatJson(ai.keys, ai.model, refactorSystemPrompt(lang), user, {
      signal, maxTokens: 16000, schema: SCHEMAS.refactor, effort: 'medium', allowThinking: true,
    });
    const usage = track(res);
    const parsed = parseRefactorResponse(res.text);
    if (!parsed.code) throw new AiError('other', 'AI tidak mengembalikan kode refactor. Coba lagi atau pilih model lain.');
    const main = unmask(parsed.code, restore);
    const alt = unmask(parsed.alternative, restore);
    const queryNames = new Set(doc.queries.filter((q) => q.key !== query.key).map((q) => (q.kind === 'partition' ? q.table : q.name)));
    return {
      code: main.code,
      alternative: alt.code,
      explanation: parsed.explanation,
      lang,
      model: modelLabel(),
      at: Date.now(),
      masked: restore.size,
      usage,
      usageText: formatUsage(usage),
      analysis: analyzeRefactor(query.code, main.code, { queryNames, leftPlaceholders: main.left }),
      altAnalysis: alt.code ? analyzeRefactor(query.code, alt.code, { queryNames, leftPlaceholders: alt.left }) : null,
    };
  }

  /**
   * Dialog: choose the comment language and run the refactor for one query.
   * @param {import('../core/mquery.js').MQuery} query
   * @param {()=>void} onDone called after the result is stored in doc.refactors
   */
  function openRefactor(query, onDone) {
    if (!ensureReady(() => openRefactor(query, onDone))) return;
    const doc = app.doc();
    openModal('Refactor dengan AI: ' + queryLabel(query), (close) => {
      const body = h('div');
      const langId = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'rf-lang', id: 'rf-lang-id', value: 'id' }));
      const langEn = /** @type {HTMLInputElement} */ (h('input', { type: 'radio', name: 'rf-lang', id: 'rf-lang-en', value: 'en' }));
      (ai.lang === 'en' ? langEn : langId).checked = true;
      const runBtn = h('button', { type: 'button', class: 'btn primary', id: 'rf-run', text: 'Jalankan' });

      const options = (error) => {
        clear(body);
        body.append(
          error ? h('div', { class: 'banner error', text: error }) : '',
          h('p', { class: 'muted', text: 'AI menulis ulang kode M query ini supaya lebih mudah dibaca: nama step yang jelas, komentar di setiap step, ringkasan query, dan catatan risiko kualitas data. Hasilnya tampil di sub-tab "Hasil refactor" dan tidak mengubah script TMDL; Anda sendiri yang menempelkannya di Power Query.' }),
          h('div', { class: 'field' }, h('span', { text: 'Bahasa komentar' }),
            h('label', { class: 'check', for: 'rf-lang-id' }, langId, ' Bahasa Indonesia'),
            h('label', { class: 'check', for: 'rf-lang-en' }, langEn, ' English')),
          h('p', { class: 'muted small' }, 'Model: ', h('strong', { text: modelLabel() }),
            ai.maskM ? ' · URL/server/path disensor saat dikirim, lalu dikembalikan di hasil' : ' · kode M dikirim tanpa sensor', ' · ',
            h('button', { type: 'button', class: 'link-btn', text: 'ubah pengaturan AI', onclick: () => openSettings(() => openRefactor(query, onDone)) })),
          h('div', { class: 'actions' }, runBtn, h('button', { type: 'button', class: 'btn ghost', text: 'Batal', onclick: close })));
      };

      runBtn.addEventListener('click', async () => {
        const lang = langEn.checked ? 'en' : 'id';
        const ctrl = new AbortController();
        clear(body);
        body.append(
          h('div', { class: 'progress-bar wide indeterminate' }, h('span')),
          h('p', { class: 'ai-progress-text', id: 'rf-progress', text: `Me-refactor ${queryLabel(query)} dengan ${modelLabel()}… Ini bisa memakan waktu hingga beberapa menit untuk query panjang.` }),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', text: 'Batalkan', onclick: () => ctrl.abort() })));
        ai.running = true;
        try {
          const result = await runRefactor(query, lang, ctrl.signal);
          if (!doc.refactors) doc.refactors = new Map();
          doc.refactors.set(query.key, result);
          ai.running = false;
          close();
          toast('Refactor selesai: ' + queryLabel(query) + ' · ' + result.usageText, 'ok');
          onDone();
        } catch (e) {
          ai.running = false;
          if (ctrl.signal.aborted) {
            options('Dibatalkan.');
            return;
          }
          options(e instanceof AiError ? e.message : 'Refactor gagal: ' + (e && e.message));
        }
      });

      options('');
      return body;
    });
  }

  return { openSettings, suggestOne, openBulk, suggestM, openBulkM, openRefactor, isReady: ready };
}
