import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = ['/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium-browser'];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(join(base, 'Google/Chrome/Application/chrome.exe'), join(base, 'Microsoft/Edge/Application/msedge.exe'));
    }
  }
  const pw = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (existsSync(pw))
    for (const d of readdirSync(pw).filter((x) => x.startsWith('chromium-')).sort().reverse()) candidates.push(join(pw, d, 'chrome-linux/chrome'), join(pw, d, 'chrome-linux64/chrome'));
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error('No Chrome/Chromium found; set CHROME_PATH');
  return found;
}

export const tmp = () => mkdtempSync(join(tmpdir(), 'pdfe-test-'));

/** Three-page document with text, a text field and a bookmark-free structure. */
export async function makeSample(path, pages = 3) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  for (let i = 1; i <= pages; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i} heading`, { x: 72, y: 700, size: 24, font });
    p.drawText(`The quick brown fox jumps over the lazy dog. Needle ${i}.`, { x: 72, y: 660, size: 12, font });
    p.drawText('Secret code 4711 must not leak', { x: 72, y: 620, size: 12, font });
    if (i === 1) form.createTextField('name').addToPage(p, { x: 72, y: 560, width: 200, height: 24 });
  }
  writeFileSync(path, await doc.save());
  return path;
}

export async function startPreview(port) {
  const srv = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview server did not start')), 20000);
    srv.stdout.on('data', (d) => d.toString().includes(String(port)) && (clearTimeout(t), resolve()));
  });
  return srv;
}

export async function pdfText(path) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { readFileSync } = await import('node:fs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), useSystemFonts: false, isEvalSupported: false, standardFontDataUrl: `${join(ROOT, 'node_modules/pdfjs-dist/standard_fonts')}/`, verbosity: 0 }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((x) => x.str).join(' '));
  }
  const outline = await doc.getOutline();
  const annots = [];
  for (let i = 1; i <= doc.numPages; i++) annots.push((await (await doc.getPage(i)).getAnnotations()).map((a) => a.subtype));
  await doc.loadingTask.destroy();
  return { pages: out, outline: outline ?? [], annots };
}
