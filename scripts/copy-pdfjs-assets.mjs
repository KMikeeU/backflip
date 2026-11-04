import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}public/pdfjs`;
mkdirSync(out, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'web/images']) {
  cpSync(`${root}node_modules/pdfjs-dist/${dir}`, `${out}/${dir.replace('web/', '')}`, { recursive: true });
}
