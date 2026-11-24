// BYOK AI clients called directly from the browser with the user's own key:
// Google Gemini (REST), Anthropic Claude (REST, browser-access header) and
// Copilotku (OpenAI format) through the BATIK Cloudflare Worker that only adds
// CORS headers (dama-explorer/web/copilotku-proxy; its ALLOWED_ORIGINS must
// include "null" for this file:// page).
// Same shape for all: chatJson() → {text, inputTokens, outputTokens}.
// Keys are never logged. Pattern follows dama-explorer/web/src/ai/providers.ts.

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
/** Worker copilotku-proxy (shared with BATIK web); its origin is also in the page CSP connect-src. */
export const COPILOTKU_PROXY_URL = 'https://batik-copilotku-proxy.ivan-saja.workers.dev';
/** Copilotku model ids carry this prefix so they never collide with Gemini/Claude ids. */
export const COPILOTKU_PREFIX = 'copilotku:';
export const REQUEST_TIMEOUT_MS = 180000;

const LABEL = { gemini: 'Gemini', claude: 'Claude', copilotku: 'Copilotku' };
const NET_OFFLINE = 'Tidak dapat terhubung ke server AI. Periksa koneksi internet Anda, lalu coba lagi.';
const NET_TIMEOUT = 'Server AI tidak merespons (waktu tunggu habis). Coba lagi beberapa saat lagi.';

export class AiError extends Error {
  /** @param {'auth'|'forbidden'|'rate'|'busy'|'network'|'timeout'|'cancelled'|'model'|'refusal'|'other'} kind */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** @param {string} model @returns {'gemini'|'claude'|'copilotku'} */
export const providerOf = (model) => (model.startsWith(COPILOTKU_PREFIX) ? 'copilotku' : /^gemini-/i.test(model) ? 'gemini' : 'claude');

const COPILOTKU_UNREACHABLE = 'Tidak dapat terhubung ke Copilotku lewat proxy. Periksa koneksi internet, dan pastikan origin "null" '
  + 'sudah ada di ALLOWED_ORIGINS Worker batik-copilotku-proxy (web/copilotku-proxy/wrangler.toml di repo dama-explorer), lalu deploy ulang.';

function statusError(provider, status, detail) {
  const p = LABEL[provider];
  if (status === 401 || (provider === 'gemini' && status === 400 && /api key/i.test(detail))) {
    return new AiError('auth', `API key ${p} ditolak. Periksa key di Pengaturan AI.`);
  }
  if (provider === 'copilotku' && status === 403 && /origin/i.test(detail)) return new AiError('forbidden', COPILOTKU_UNREACHABLE);
  if (status === 402 && provider === 'copilotku') return new AiError('rate', 'Saldo Copilotku habis (402). Isi ulang saldo di console Copilotku, atau pilih model lain.');
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
    // A Worker that rejects the origin answers without CORS headers, so the browser only reports a network error.
    throw new AiError('network', provider === 'copilotku' ? COPILOTKU_UNREACHABLE : NET_OFFLINE);
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
    data = await call(!opt.allowThinking);
  } catch (e) {
    if (opt.allowThinking) throw e;
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

const strObj = (props) => ({
  type: 'object',
  properties: Object.fromEntries(props.map((k) => [k, { type: 'string' }])),
  required: props,
  additionalProperties: false,
});

/** JSON schemas for Claude structured output, one per feature (Gemini/Copilotku rely on the prompt). */
export const SCHEMAS = {
  /** object descriptions: {"items":[{id, description}]} */
  descriptions: {
    type: 'json_schema',
    schema: { type: 'object', properties: { items: { type: 'array', items: strObj(['id', 'description']) } }, required: ['items'], additionalProperties: false },
  },
  /** Power Query step descriptions: {"queryDescription", "steps":[{id, description}]} */
  mquery: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { queryDescription: { type: 'string' }, steps: { type: 'array', items: strObj(['id', 'description']) } },
      required: ['queryDescription', 'steps'],
      additionalProperties: false,
    },
  },
  /** M refactor: {"refactoredCode", "alternativeCode", "explanation"} */
  refactor: { type: 'json_schema', schema: strObj(['refactoredCode', 'alternativeCode', 'explanation']) },
};

async function claudeChat(key, model, system, user, opt) {
  const base = { model, system, max_tokens: opt.maxTokens || 8000, messages: [{ role: 'user', content: user }] };
  const call = (body) => request('claude', `${ANTHROPIC_BASE}/messages`, {
    method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(body),
  }, opt.signal);
  let res;
  try {
    res = await call({ ...base, output_config: { effort: opt.effort || 'low', ...(opt.schema ? { format: opt.schema } : {}) } });
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

// --------------------------------------------------------------- Copilotku

const copilotkuHeaders = (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` });

/** Copilotku model ids (without prefix), alphabetical. */
export async function listCopilotkuModels(key, signal) {
  const data = await request('copilotku', `${COPILOTKU_PROXY_URL}/v1/models`, { method: 'GET', headers: copilotkuHeaders(key) }, signal);
  const items = (Array.isArray(data) ? data : data && data.data) || [];
  const ids = items.map((m) => (m && typeof m === 'object' ? m.id : m)).filter((id) => typeof id === 'string' && id);
  return ids.sort((a, b) => a.localeCompare(b)).map((id) => ({ id, label: id }));
}

async function copilotkuChat(key, model, system, user, opt) {
  const body = {
    model: model.slice(COPILOTKU_PREFIX.length),
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    reasoning_effort: opt.effort || 'low',
    ...(opt.maxTokens ? { max_tokens: opt.maxTokens } : {}),
  };
  const call = () => request('copilotku', `${COPILOTKU_PROXY_URL}/v1/chat/completions`, {
    method: 'POST', headers: copilotkuHeaders(key), body: JSON.stringify(body),
  }, opt.signal);
  let data;
  try {
    data = await call();
  } catch (e) {
    // Non-reasoning models (e.g. GPT-4o) may reject reasoning_effort: retry once without.
    if (!(e instanceof AiError && e.kind === 'other' && /\(400\)/.test(e.message))) throw e;
    delete body.reasoning_effort;
    data = await call();
  }
  const choice = (data && data.choices && data.choices[0]) || {};
  const u = (data && data.usage) || {};
  return {
    text: (choice.message && choice.message.content) || '',
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
  };
}

// ------------------------------------------------------------------ common

/**
 * @param {{gemini?:string, claude?:string, copilotku?:string}} keys
 * @param {string} model
 * @param {string} system
 * @param {string} user
 * @param {{signal?:AbortSignal, maxTokens?:number, schema?:object, effort?:'low'|'medium'|'high', allowThinking?:boolean}} [opt]
 *   schema: Claude structured-output format (see SCHEMAS); effort: Claude/Copilotku reasoning effort (default low);
 *   allowThinking: let Gemini think (default: thinking off for short JSON answers)
 */
export function chatJson(keys, model, system, user, opt = {}) {
  const provider = providerOf(model);
  const key = keys[provider];
  if (!key) return Promise.reject(new AiError('auth', `Belum ada API key ${LABEL[provider]}. Isi di Pengaturan AI.`));
  if (provider === 'gemini') return geminiChat(key, model, system, user, opt);
  if (provider === 'copilotku') return copilotkuChat(key, model, system, user, opt);
  return claudeChat(key, model, system, user, opt);
}

/**
 * Models from every provider that has a key.
 * @param {{gemini?:string, claude?:string, copilotku?:string}} keys
 * @returns {Promise<{models:{id:string, label:string, provider:'gemini'|'claude'|'copilotku'}[], errors:string[]}>}
 */
export async function listModels(keys, signal) {
  const models = [];
  const errors = [];
  const [g, c, k] = await Promise.allSettled([
    keys.gemini ? listGeminiModels(keys.gemini, signal) : Promise.resolve([]),
    keys.claude ? listClaudeModels(keys.claude, signal) : Promise.resolve([]),
    keys.copilotku ? listCopilotkuModels(keys.copilotku, signal) : Promise.resolve([]),
  ]);
  if (g.status === 'fulfilled') models.push(...g.value.map((m) => ({ ...m, provider: 'gemini' })));
  else errors.push('Gemini: ' + g.reason.message);
  if (c.status === 'fulfilled') models.push(...c.value.map((m) => ({ ...m, provider: 'claude' })));
  else errors.push('Claude: ' + c.reason.message);
  if (k.status === 'fulfilled') models.push(...k.value.map((m) => ({ id: COPILOTKU_PREFIX + m.id, label: m.label, provider: 'copilotku' })));
  else errors.push('Copilotku: ' + k.reason.message);
  return { models, errors };
}

/** Cheapest sensible default: newest Gemini Flash-Lite, else newest Claude Haiku, else a Copilotku Haiku, else the first model. */
export function defaultModel(models) {
  const lite = models.find((m) => m.provider === 'gemini' && m.id.endsWith('-flash-lite'));
  const haiku = models.find((m) => m.provider === 'claude' && /haiku/i.test(m.id));
  const kHaiku = models.find((m) => m.provider === 'copilotku' && /haiku/i.test(m.id));
  const first = lite || haiku || kHaiku || models[0];
  return first ? first.id : null;
}
