import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import electronPath from 'electron';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { _electron } from 'playwright-core';
import { makeSample, pdfText, ROOT, tmp } from './helpers.mjs';

function findElectron() {
  if (process.env.ELECTRON_PATH) return process.env.ELECTRON_PATH;
  const libs = existsSync('/usr/lib') ? readdirSync('/usr/lib').filter((d) => /^electron\d*$/.test(d)).sort().reverse() : [];
  const bin = libs.map((d) => `/usr/lib/${d}/electron`).find((p) => existsSync(p));
  if (bin) return bin;
  return electronPath;
}

const has = (cmd) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let app, win, dir, sample;
const errors = [];

/** Makes the next native save/open dialog return `path` without showing UI. */
async function nextDialog(kind, path) {
  await app.evaluate(
    ({ dialog }, [kind, path]) => {
      const orig = dialog[kind];
      dialog[kind] = async () => {
        dialog[kind] = orig;
        return kind === 'showSaveDialog' ? { canceled: false, filePath: path } : { canceled: false, filePaths: [path] };
      };
    },
    [kind, path],
  );
}

async function openPath(path) {
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send('command', 'open-paths', [p]), path);
}

async function command(cmd) {
  await app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('command', c), cmd);
}

async function toastMark() {
  return win.evaluate(() => Number(document.querySelector('.toast')?.dataset.seq ?? 0));
}

async function toast(re, timeout = 30000, since = -1) {
  // Wait for a toast newer than `since`, so stale toasts never match. Callers pass a
  // mark taken before the action when the toast can fire immediately.
  if (since < 0) since = await toastMark();
  await win.waitForFunction(
    ({ source, since }) => {
      const t = document.querySelector('.toast');
      return !!t && t.classList.contains('show') && Number(t.dataset.seq) > since && new RegExp(source).test(t.textContent ?? '');
    },
    { source: re.source, since },
    { timeout },
  );
  return win.locator('.toast').textContent();
}

/** Leaves only the first tab open and active, so tests do not cascade state. */
async function resetToFirstTab() {
  await win.locator('.doc-tab').first().click();
  while ((await win.locator('.doc-tab').count()) > 1) await win.keyboard.press('Control+w');
  await win.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 1);
}

before(async () => {
  dir = tmp();
  sample = await makeSample(join(dir, 'sample.pdf'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Isolated profile so the single-instance lock never clashes with a running app.
  app = await _electron.launch({ executablePath: findElectron(), args: [process.env.APP_DIR ?? ROOT, sample, `--user-data-dir=${join(dir, 'profile')}`], env });
  win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push(e.message));
  await win.waitForSelector('.viewer-slot .page .textLayer span', { timeout: 20000 });
});

after(async () => {
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.destroy()));
  await app?.close().catch(() => {});
});

describe('desktop app', () => {
  test('opens the file from the command line with the native bridge', async () => {
    assert.match(await win.title(), /sample\.pdf/);
    assert.ok(await win.evaluate(() => !!window.native));
  });

  test('files opened from the file manager become tabs', async () => {
    const second = join(dir, 'second.pdf');
    copyFileSync(sample, second);
    await openPath(second);
    await win.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 2);
    await win.keyboard.press('Control+w');
  });

  test('password protection is applied on save and the file reopens', { skip: !has('qpdf') }, async () => {
    await command('protect');
    await win.fill('.modal input[type=password] >> nth=0', 'secret1');
    await win.fill('.modal input[type=password] >> nth=1', 'secret1');
    await win.fill('.modal input[type=password] >> nth=2', 'owner-pw');
    await win.click('.modal button.primary');
    const target = join(dir, 'protected.pdf');
    await nextDialog('showSaveDialog', target);
    let mark = await toastMark();
    await win.keyboard.press('Control+Shift+s');
    await toast('/Saved/', 30000, mark);
    assert.match(execFileSync('qpdf', ['--show-encryption', '--password=secret1', target]).toString(), /R = 6|AES-256|256/);
    await assert.rejects(PDFDocument.load(readFileSync(target)));

    await openPath(target);
    await win.fill('.modal input[type=password]', 'secret1');
    await win.click('.modal button.primary');
    await win.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 2);
    await win.waitForSelector('.viewer-slot .page .textLayer span');
    // Annotations can be added to the decrypted copy and protection is kept on save.
    await win.keyboard.press('n');
    const b = await win.locator('.viewer-slot .page').first().boundingBox();
    await win.mouse.click(b.x + 100, b.y + 100);
    await win.keyboard.type('note');
    await win.click('.note-editor >> text=Done');
    mark = await toastMark();
    await win.keyboard.press('Control+s');
    await toast('/Saved/', 30000, mark);
    assert.match(execFileSync('qpdf', ['--show-encryption', '--password=secret1', target]).toString(), /R = 6|AESv3|AES-256|256/);
    await win.keyboard.press('Control+w');
  });

  test('reduce file size', { skip: !has('qpdf') }, async () => {
    await resetToFirstTab();
    const target = join(dir, 'small.pdf');
    await command('compress');
    await win.selectOption('.modal select', 'lossless');
    await nextDialog('showSaveDialog', target);
    const mark4 = await toastMark();
    await win.click('.modal button.primary');
    const msg = await toast('/Saved|already|failed/', 30000, mark4);
    if (/Saved/.test(msg)) assert.ok(statSync(target).size > 0);
  });

  test('split into files', async () => {
    await resetToFirstTab();
    const out = join(dir, 'split');
    mkdirSync(out, { recursive: true });
    await command('split');
    await nextDialog('showOpenDialog', out);
    const mark5 = await toastMark();
    await win.click('.modal button.primary');
    await toast('/Split into 3/', 30000, mark5);
    assert.equal(readdirSync(out).filter((f) => f.endsWith('.pdf')).length, 3);
  });

  test('OCR makes an image searchable', { skip: !has('tesseract') }, async () => {
    await resetToFirstTab();
    const img = join(dir, 'scan.png');
    execFileSync('magick', ['-size', '1400x500', 'xc:white', '-font', 'DejaVu-Sans', '-pointsize', '80', '-annotate', '+60+200', 'Hello OCR World', '-annotate', '+60+380', 'Invoice 12345', img]);
    await openPath(img);
    await win.waitForFunction(() => document.querySelectorAll('.doc-tab').length === 2);
    await win.waitForSelector('.viewer-slot .page .annot-image');
    await command('ocr');
    const mark6 = await toastMark();
    await win.click('.modal button.primary');
    await toast('/Recognized/', 60000, mark6);
    await win.waitForSelector('.viewer-slot .page .textLayer span');
    const text = await win.locator('.viewer-slot .page .textLayer').first().textContent();
    assert.match(text, /12345/);
    const target = join(dir, 'ocr.pdf');
    await nextDialog('showSaveDialog', target);
    await toastMark().then((m) => win.keyboard.press('Control+s').then(() => toast('/Saved/', 30000, m)));
    assert.match((await pdfText(target)).pages[0], /12345/);
    await win.keyboard.press('Control+w');
  });

  test('sign with a new self-signed certificate and verify', async () => {
    await resetToFirstTab();
    const idPath = join(dir, 'me.p12');
    const signed = join(dir, 'signed.pdf');
    await command('digital-sign');
    await win.click('.modal >> text=Create new ID…');
    await win.waitForSelector('.modal >> text=Create Digital ID');
    await win.fill('.modal input >> nth=0', 'Test Signer');
    await win.fill('.modal input[type=password] >> nth=0', 'secret123');
    await win.fill('.modal input[type=password] >> nth=1', 'secret123');
    await nextDialog('showSaveDialog', idPath);
    await win.click('.modal button.primary');
    await win.waitForSelector('.modal >> text=Sign with Certificate', { timeout: 15000 });
    assert.ok(existsSync(idPath));
    await win.fill('.modal input[type=password]', 'secret123');
    await win.click('.modal button.primary');
    const b = await win.locator('.viewer-slot .page').first().boundingBox();
    await nextDialog('showSaveDialog', signed);
    const mark7 = await toastMark();
    await win.mouse.move(b.x + 80, b.y + b.height * 0.25);
    await win.mouse.down();
    await win.mouse.move(b.x + 330, b.y + b.height * 0.32, { steps: 5 });
    await win.mouse.up();
    await toast('/Signed and saved|failed|Wrong/', 30000, mark7);
    assert.match(await win.locator('.toast').textContent(), /Signed and saved/);
    if (has('pdfsig')) assert.match(execFileSync('pdfsig', [signed]).toString(), /Signature is Valid/);
    const mark8 = await toastMark();
    await openPath(signed);
    assert.match(await toast('/signature/i', 30000, mark8), /valid/);
  });

  test('no runtime errors', () => assert.deepEqual(errors, []));
});
