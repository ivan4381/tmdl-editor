// Tiny DOM helpers. No framework.

/**
 * Create an element. attrs: class, text, html is NOT supported (no innerHTML from data).
 * Keys starting with "on" attach listeners; `dataset` sets data-*; boolean false skips.
 * @param {string} tag
 * @param {Record<string, any>=} attrs
 * @param {...(Node|string|null|undefined|false|(Node|string)[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendAll(el, children);
  return el;
}

function appendAll(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendAll(el, c);
    else el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

/** @param {string} sel */
export function $(sel, root = document) {
  return /** @type {HTMLElement} */ (root.querySelector(sel));
}

/** Remove all children. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

let toastTimer = 0;
/** @param {string} msg @param {'ok'|'error'|'info'} [kind] */
export function toast(msg, kind = 'info') {
  const el = $('#toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

/**
 * Trigger a file download from a string (UTF-8). A leading U+FEFF becomes EF BB BF.
 * @param {string} filename
 * @param {string} content
 * @param {string} [mime]
 */
export function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Copy text to the clipboard; falls back to execCommand for older browsers / file://.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Debounce. */
export function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = () => {
    clearTimeout(t);
    fn();
  };
  return wrapped;
}

/** Auto-grow a textarea to its content. */
export function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

/**
 * Open the shared <dialog> with content. Returns a close function.
 * @param {string} title
 * @param {(close:()=>void)=>(Node|Node[])} build
 */
export function openModal(title, build) {
  const dlg = /** @type {HTMLDialogElement} */ ($('#modal'));
  clear(dlg);
  const close = () => {
    if (dlg.open) dlg.close();
  };
  const body = build(close);
  dlg.append(
    h('div', { class: 'modal-head' },
      h('h2', { text: title }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Tutup', onclick: close, text: '×' })),
    h('div', { class: 'modal-body' }, body),
  );
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  return close;
}

/** Format a number with Indonesian grouping. */
export function fmt(n) {
  return n.toLocaleString('id-ID');
}
