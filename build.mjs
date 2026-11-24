// Build: inline src/styles.css and every ES module reachable from src/ui/app.js
// into dist/tmdl-description-editor.html. Pure Node, no dependencies.
//
// Each module becomes `__def(path, function (exports) { ... })`; static imports
// are rewritten to `const { a, b } = __req(path)`. Only the module syntax used
// in this repo is supported (named imports, `export function|const|class`);
// anything else fails the build loudly.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const srcDir = join(root, 'src');
const entry = 'ui/app.js';
const outFile = join(root, 'dist', 'tmdl-description-editor.html');

const IMPORT_RE = /^import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+((?:async\s+)?function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function resolveSpec(fromId, spec) {
  if (!spec.startsWith('.')) throw new Error(`${fromId}: only relative imports are supported (${spec})`);
  return posix.normalize(posix.join(posix.dirname(fromId), spec));
}

/** @type {Map<string, string>} id → transformed code */
const modules = new Map();
const order = [];

function load(id, stack = []) {
  if (modules.has(id)) return;
  if (stack.includes(id)) throw new Error('Circular import: ' + [...stack, id].join(' → '));
  const file = join(srcDir, id);
  let code = readFileSync(file, 'utf8');
  const deps = [];
  code = code.replace(IMPORT_RE, (_, names, ns, spec) => {
    const dep = resolveSpec(id, spec);
    deps.push(dep);
    if (ns) return `const ${ns} = __req(${JSON.stringify(dep)});`;
    const binds = names.split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.replace(/^([\w$]+)\s+as\s+([\w$]+)$/, '$1: $2'));
    return `const { ${binds.join(', ')} } = __req(${JSON.stringify(dep)});`;
  });
  if (/^\s*import\s/m.test(code)) throw new Error(`${id}: unsupported import syntax`);
  const exported = [];
  code = code.replace(EXPORT_DECL_RE, (m, kind, name) => {
    exported.push(name);
    return m.replace(/^export\s+/, '');
  });
  if (/^\s*export\s/m.test(code)) throw new Error(`${id}: unsupported export syntax (use export function/const/class)`);
  modules.set(id, null);
  for (const d of deps) load(d, [...stack, id]);
  const tail = exported.map((n) => `exports.${n} = ${n};`).join(' ');
  modules.set(id, `__def(${JSON.stringify(id)}, function (exports) {\n${code}\n${tail}\n});`);
  order.push(id);
}

load(entry);

const runtime = `(function () {
'use strict';
var __mods = Object.create(null), __cache = Object.create(null);
function __def(id, fn) { __mods[id] = fn; }
function __req(id) {
  if (__cache[id]) return __cache[id];
  var exp = {}; __cache[id] = exp; __mods[id](exp); return exp;
}
${order.map((id) => modules.get(id)).join('\n\n')}
__req(${JSON.stringify(entry)});
})();`;

// Fail the build on syntax errors (e.g. a duplicate declaration) instead of shipping a broken page.
try {
  new Function(runtime); // parse only, nothing runs
} catch (e) {
  throw new Error('Bundled JavaScript has a syntax error: ' + e.message);
}

const css = readFileSync(join(srcDir, 'styles.css'), 'utf8');
const template = readFileSync(join(srcDir, 'index.html'), 'utf8');
const safeJs = runtime.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const safeCss = css.replace(/<\/style/gi, '<\\/style');

// split/join instead of String.replace: the payload contains `$` sequences.
const pieces = template.split('<!--INLINE_CSS-->');
if (pieces.length !== 2) throw new Error('index.html must contain <!--INLINE_CSS--> exactly once');
let html = pieces.join(safeCss);
const jsPieces = html.split('<!--INLINE_JS-->');
if (jsPieces.length !== 2) throw new Error('index.html must contain <!--INLINE_JS--> exactly once');
html = jsPieces.join(safeJs);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html);
console.log(`Built ${relative(root, outFile)} (${(html.length / 1024).toFixed(1)} KB, ${order.length} modules: ${order.join(', ')})`);
