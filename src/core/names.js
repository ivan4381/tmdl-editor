// TMDL object names: quoted ('Total Sales', 'Cust''s Name') or bare (VL06F+MB51, Staging\VL06F).

/** Regex source for one name token (quoted or bare). */
export const NAME_SRC = "'(?:[^']|'')+'|[^\\s=:'.]+";

/**
 * Remove the surrounding quotes and unescape '' → '.
 * Bare names are returned unchanged.
 * @param {string} token
 */
export function parseObjectName(token) {
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  return token;
}

/**
 * Quote a name when TMDL requires it (contains . = : ' or whitespace,
 * or starts/ends oddly). Single quotes inside are doubled.
 * @param {string} name
 */
export function quoteName(name) {
  if (name === '' || /[.=:'\s]/.test(name)) {
    return "'" + name.replace(/'/g, "''") + "'";
  }
  return name;
}
