import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Read a fixture as a string, BOM and CRLF preserved. */
export function fixture(name) {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}
