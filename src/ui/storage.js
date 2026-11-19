// localStorage drafts. Every access is wrapped in try/catch: storage may be
// disabled, full, or unavailable on file:// in some browsers.

const PREFIX = 'tmdl-desc-editor:v1:';
const INDEX_KEY = PREFIX + 'drafts';
const PREFS_KEY = PREFIX + 'prefs';
const MAX_DRAFTS = 12;

function read(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * @typedef {{hash:string, name:string, savedAt:number, edits:[string,string][]}} Draft
 */

/** @param {string} hash @returns {Draft|null} */
export function loadDraft(hash) {
  const d = read(PREFIX + 'draft:' + hash);
  if (!d || !Array.isArray(d.edits)) return null;
  return d;
}

/**
 * Save (or delete when there are no edits) the draft for one input text.
 * @param {string} hash
 * @param {string} name
 * @param {Map<string,string>} edits
 */
export function saveDraft(hash, name, edits) {
  if (edits.size === 0) {
    deleteDraft(hash);
    return true;
  }
  const ok = write(PREFIX + 'draft:' + hash, { hash, name, savedAt: Date.now(), edits: [...edits] });
  if (!ok) return false;
  let index = read(INDEX_KEY);
  if (!Array.isArray(index)) index = [];
  index = [hash, ...index.filter((x) => x !== hash)];
  for (const old of index.slice(MAX_DRAFTS)) remove(PREFIX + 'draft:' + old);
  write(INDEX_KEY, index.slice(0, MAX_DRAFTS));
  return true;
}

/** @param {string} hash */
export function deleteDraft(hash) {
  remove(PREFIX + 'draft:' + hash);
  const index = read(INDEX_KEY);
  if (Array.isArray(index)) write(INDEX_KEY, index.filter((x) => x !== hash));
}

/** @returns {Record<string, any>} */
export function loadPrefs() {
  const p = read(PREFS_KEY);
  return p && typeof p === 'object' ? p : {};
}

/** @param {Record<string, any>} patch */
export function savePrefs(patch) {
  write(PREFS_KEY, { ...loadPrefs(), ...patch });
}

// ---------- AI keys (BYOK) ----------
// Default sessionStorage: gone when the tab closes. "Ingat key" uses localStorage.
const AI_KEYS = PREFIX + 'ai-keys';

function readKeys(store) {
  try {
    const raw = store && store.getItem(AI_KEYS);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
    return { gemini: str(v.gemini), claude: str(v.claude) };
  } catch {
    return null;
  }
}

function store(kind) {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** @returns {{keys:{gemini?:string, claude?:string}, remember:boolean}} */
export function loadAiKeys() {
  const local = readKeys(store('local'));
  if (local) return { keys: local, remember: true };
  return { keys: readKeys(store('session')) || {}, remember: false };
}

/** @param {{gemini?:string, claude?:string}} keys @param {boolean} remember */
export function saveAiKeys(keys, remember) {
  const clean = { gemini: (keys.gemini || '').trim() || undefined, claude: (keys.claude || '').trim() || undefined };
  const target = store(remember ? 'local' : 'session');
  const other = store(remember ? 'session' : 'local');
  try {
    if (other) other.removeItem(AI_KEYS);
    if (clean.gemini || clean.claude) target && target.setItem(AI_KEYS, JSON.stringify(clean));
    else if (target) target.removeItem(AI_KEYS);
  } catch {
    /* storage blocked: keys stay in memory until the tab closes */
  }
}
