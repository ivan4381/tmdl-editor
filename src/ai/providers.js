// BYOK AI clients called directly from the browser with the user's own key:
// Google Gemini (REST) and Anthropic Claude (REST, browser-access header).
// Same shape for both: chatJson() → {text, inputTokens, outputTokens}.
// Keys are never logged. Pattern follows dama-explorer/web/src/ai/providers.ts.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
export const REQUEST_TIMEOUT_MS = 180000;

const LABEL = { gemini: 'Gemini', claude: 'Claude' };
const NET_OFFLINE = 'Tidak dapat terhubung ke server AI. Periksa koneksi internet Anda, lalu coba lagi.';
const NET_TIMEOUT = 'Server AI tidak merespons (waktu tunggu habis). Coba lagi beberapa saat lagi.';

export class AiError extends Error {
  /** @param {'auth'|'forbidden'|'rate'|'busy'|'network'|'timeout'|'cancelled'|'model'|'refusal'|'other'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** @param {string} model */
export const providerOf = (model) => (/^gemini-/i.test(model) ? 'gemini' : 'claude');

function statusError(provider, status, detail) {
  const p = LABEL[provider];
  if (status === 401 || (provider === 'gemini' && status === 400 && /api key/i.test(detail))) {
    return new AiError('auth', `API key ${p} ditolak. Periksa key di Pengaturan AI.`);
  }
  if (status === 403) {
    return new AiError('forbidden', provider === 'gemini'
      ? 'Key Gemini ditolak (403). Pastikan key mengizinkan Generative Language API dan tidak dibatasi HTTP referrer.'
      : `Key ${p} tidak punya izin untuk permintaan ini (403).`);
  }
  if (status === 404) return new AiError('model', `Model tidak ditemukan di ${p}. Pilih model lain.`);
  if (status === 429) return new AiError('rate', `Batas pemakaian ${p} tercapai (429). Tunggu sebentar lalu coba lagi, atau pilih model lain.`);
  if (status === 529 || status >= 500) return new AiError('busy', `Server ${p} sedang sibuk atau bermasalah (${status}). Coba lagi beberapa saat lagi.`);
  return new AiError('other', `Permintaan ditolak oleh ${p} (${status})${detail ? `: ${detail}` : ''}`);
}

function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  let timed = false;
  const t = setTimeout(() => {
    timed = true;
    ctrl.abort();
  }, ms);
  const onAbort = () => ctrl.abort();
  if (signal) {
    signal.addEventListener('abort', onAbort);
    if (signal.aborted) ctrl.abort();
  }
  return {
    signal: ctrl.signal,
    timedOut: () => timed,
    done: () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function request(provider, url, init, signal) {
  const tm = withTimeout(signal, REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, signal: tm.signal });
  } catch {
    if (signal && signal.aborted) throw new AiError('cancelled', 'Dibatalkan.');
    if (tm.timedOut()) throw new AiError('timeout', NET_TIMEOUT);
    throw new AiError('network', NET_OFFLINE);
  } finally {
    tm.done();
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = body && body.error;
    const detail = typeof err === 'string' ? err : (err && err.message) || '';
    throw statusError(provider, res.status, detail);
  }
  return body;
}

// ------------------------------------------------------------------ Gemini

const GEMINI_VARIANTS = ['flash-lite', 'flash', 'pro'];
const GEMINI_MODEL_PATTERN = new RegExp(`^gemini-(\\d+(?:\\.\\d+)*)-(${GEMINI_VARIANTS.join('|')})$`);

/** Stable Gemini models, newest version first; within a version flash-lite, flash, pro. */
export async function listGeminiModels(key, signal) {
  const found = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ pageSize: '1000', ...(pageToken ? { pageToken } : {}) });
    const data = await request('gemini', `${GEMINI_BASE}/models?${q}`, { method: 'GET', headers: { 'x-goog-api-key': key } }, signal);
    for (const m of (data && data.models) || []) {
      const name = String(m.name || '').replace(/^models\//, '');
      const match = GEMINI_MODEL_PATTERN.exec(name);
      if (match && (m.supportedGenerationMethods || ['generateContent']).includes('generateContent')) {
        found.push({ version: match[1].split('.').map(Number), variant: GEMINI_VARIANTS.indexOf(match[2]), name, label: m.displayName || name });
      }
    }
    pageToken = (data && data.nextPageToken) || '';
  } while (pageToken);
  found.sort((a, b) => {
    for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
      const d = (b.version[i] || 0) - (a.version[i] || 0);
      if (d) return d;
    }
    return a.variant - b.variant;
  });
  return found.map((f) => ({ id: f.name, label: f.label }));
}

async function geminiChat(key, model, system, user, opt) {
  const call = (thinkingOff) => request('gemini', `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.3,
        ...(thinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  }, opt.signal);
  let data;
  try {
    data = await call(true);
  } catch (e) {
    // Models that cannot turn thinking off reject budget 0 (Gemini 3 with a generic 400): retry without.
    if (!(e instanceof AiError && e.kind === 'other' && /think|\(400\)/i.test(e.message))) throw e;
    data = await call(false);
  }
  const cand = (data && data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const meta = (data && data.usageMetadata) || {};
  const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('');
  if (!text && (cand.finishReason === 'SAFETY' || (data && data.promptFeedback && data.promptFeedback.blockReason))) {
    throw new AiError('refusal', 'Jawaban diblokir filter keamanan Gemini. Coba model lain.');
  }
  return {
    text,
    inputTokens: meta.promptTokenCount || 0,
    outputTokens: (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0),
  };
}

// ------------------------------------------------------------------ Claude

const anthropicHeaders = (key) => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  // BYOK: the key belongs to the user and is used from their own browser.
  'anthropic-dangerous-direct-browser-access': 'true',
});

/** Claude models, newest first. */
export async function listClaudeModels(key, signal) {
  const out = [];
  let after = '';
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ limit: '100', ...(after ? { after_id: after } : {}) });
    const data = await request('claude', `${ANTHROPIC_BASE}/models?${q}`, { method: 'GET', headers: anthropicHeaders(key) }, signal);
    for (const m of (data && data.data) || []) out.push({ id: m.id, label: m.display_name || m.id, created: m.created_at || '' });
    if (!data || !data.has_more || !data.last_id) break;
    after = data.last_id;
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created))).map(({ id, label }) => ({ id, label }));
}

const SUGGESTION_SCHEMA = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, description: { type: 'string' } },
          required: ['id', 'description'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  },
};

async function claudeChat(key, model, system, user, opt) {
  const base = { model, system, max_tokens: opt.maxTokens || 8000, messages: [{ role: 'user', content: user }] };
  const call = (body) => request('claude', `${ANTHROPIC_BASE}/messages`, {
    method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(body),
  }, opt.signal);
  let res;
  try {
    res = await call({ ...base, output_config: { effort: 'low', format: SUGGESTION_SCHEMA } });
  } catch (e) {
    // Older models reject effort / structured output: retry plain (the prompt already asks for JSON).
    if (!(e instanceof AiError && e.kind === 'other' && /effort|output_config|format|schema|\(400\)/i.test(e.message))) throw e;
    res = await call(base);
  }
  if (res && res.stop_reason === 'refusal') throw new AiError('refusal', 'Model menolak permintaan ini. Coba model lain.');
  const u = (res && res.usage) || {};
  return {
    text: ((res && res.content) || []).map((b) => (b.type === 'text' ? b.text : '')).join(''),
    inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    outputTokens: u.output_tokens || 0,
  };
}

// ------------------------------------------------------------------ common

/**
 * @param {{gemini?:string, claude?:string}} keys
 * @param {string} model
 * @param {string} system
 * @param {string} user
 * @param {{signal?:AbortSignal, maxTokens?:number}} [opt]
 */
export function chatJson(keys, model, system, user, opt = {}) {
  const provider = providerOf(model);
  const key = keys[provider];
  if (!key) return Promise.reject(new AiError('auth', `Belum ada API key ${LABEL[provider]}. Isi di Pengaturan AI.`));
  return provider === 'gemini' ? geminiChat(key, model, system, user, opt) : claudeChat(key, model, system, user, opt);
}

/**
 * Models from every provider that has a key.
 * @param {{gemini?:string, claude?:string}} keys
 * @returns {Promise<{models:{id:string, label:string, provider:'gemini'|'claude'}[], errors:string[]}>}
 */
export async function listModels(keys, signal) {
  const models = [];
  const errors = [];
  const [g, c] = await Promise.allSettled([
    keys.gemini ? listGeminiModels(keys.gemini, signal) : Promise.resolve([]),
    keys.claude ? listClaudeModels(keys.claude, signal) : Promise.resolve([]),
  ]);
  if (g.status === 'fulfilled') models.push(...g.value.map((m) => ({ ...m, provider: 'gemini' })));
  else errors.push('Gemini: ' + g.reason.message);
  if (c.status === 'fulfilled') models.push(...c.value.map((m) => ({ ...m, provider: 'claude' })));
  else errors.push('Claude: ' + c.reason.message);
  return { models, errors };
}

/** Cheapest sensible default: newest Gemini Flash-Lite, else newest Claude Haiku, else the first model. */
export function defaultModel(models) {
  const lite = models.find((m) => m.provider === 'gemini' && m.id.endsWith('-flash-lite'));
  const haiku = models.find((m) => m.provider === 'claude' && /haiku/i.test(m.id));
  const first = lite || haiku || models[0];
  return first ? first.id : null;
}
