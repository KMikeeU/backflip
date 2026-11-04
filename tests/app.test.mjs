import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright-core';
import { findChrome, makeSample, pdfText, startPreview, tmp } from './helpers.mjs';

const PORT = 5300 + Math.floor(Math.random() * 400);
let srv, browser, page, dir, sample;
const errors = [];

async function open(path) {
  const btn = (await page.locator('.welcome').isVisible()) ? page.locator('text=Open file…') : page.locator('[title="Open (Ctrl+O)"]');
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), btn.click()]);
  await fc.setFiles(path);
  await page.waitForSelector('.viewer-slot .page .textLayer span');
  await page.waitForTimeout(300);
}

const firstPage = () => page.locator('.viewer-slot .pdfViewer .page').first();
/** Client coordinates of a relative point on page 1, scrolling it into the middle of the viewer first. */
async function at(fx, fy) {
  await page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector('.viewer-slot .viewer-container');
      const p = c.querySelector('.page');
      const cr = c.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      const y = pr.top + pr.height * fy;
      const x = pr.left + pr.width * fx;
      if (y < cr.top + 80 || y > cr.bottom - 80) c.scrollTop += y - (cr.top + cr.height / 2);
      if (x < cr.left + 40 || x > cr.right - 40) c.scrollLeft += x - (cr.left + cr.width / 2);
    },
    [fx, fy],
  );
  await page.waitForTimeout(50);
  const b = await firstPage().boundingBox();
  return [b.x + b.width * fx, b.y + b.height * fy];
}
async function drag(from, to) {
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(...to, { steps: 6 });
  await page.mouse.up();
}
async function selectText(text) {
  await at(0.5, 0.15);
  const span = firstPage().locator('.textLayer span', { hasText: text }).first();
  const b = await span.boundingBox();
  await drag([b.x + 1, b.y + b.height / 2], [b.x + b.width - 1, b.y + b.height / 2]);
  await page.waitForTimeout(100);
}
async function save(name) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const out = join(dir, name);
  await dl.saveAs(out);
  return out;
}
const count = (sel) => page.locator(`.viewer-slot ${sel}`).count();

before(async () => {
  dir = tmp();
  sample = await makeSample(join(dir, 'sample.pdf'));
  srv = await startPreview(PORT);
  browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(`http://localhost:${PORT}/`);
  await page.evaluate(() => localStorage.setItem('settings', JSON.stringify({ author: 'Tester', rememberPosition: false, snap: false })));
  await page.reload();
});

after(async () => {
  await browser?.close();
  srv?.kill();
});

describe('editor', () => {
  test('opens and renders a PDF', async () => {
    await open(sample);
    assert.equal(await count('.pdfViewer .page'), 3);
    assert.equal(await page.locator('.thumb').count(), 3);
  });

  test('annotations round-trip as editable PDF annotations', async () => {
    await page.keyboard.press('t');
    await page.mouse.click(...(await at(0.5, 0.35)));
    await page.keyboard.type('Hello world');
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    await drag(await at(0.2, 0.5), await at(0.3, 0.55));
    await drag(await at(0.2, 0.6), await at(0.3, 0.62));
    await page.keyboard.press('r');
    await drag(await at(0.6, 0.5), await at(0.8, 0.6));
    await page.keyboard.press('v');
    await selectText('quick brown');
    await page.click('.markbar >> text=Highlight');
    const hl = await firstPage().locator('.annot-markup').boundingBox();
    const line = await firstPage().locator('.textLayer span', { hasText: 'quick brown' }).first().boundingBox();
    assert.ok(Math.abs(hl.x - line.x) < 3 && Math.abs(hl.width - line.width) < 6, `highlight ${JSON.stringify(hl)} vs text ${JSON.stringify(line)}`);
    await page.keyboard.press('n');
    await page.mouse.click(...(await at(0.85, 0.15)));
    await page.keyboard.type('A comment');
    await page.click('.note-editor >> text=Done');
    // Two quick strokes merge into one drawing.
    assert.equal(await count('.annot-ink'), 1);
    const kinds = await page.locator('.viewer-slot .annot').evaluateAll((els) => els.map((e) => e.getAttribute('class')));
    assert.equal(kinds.length, 5, kinds.join());

    const out = await save('annots.pdf');
    const info = await pdfText(out);
    assert.deepEqual(info.annots[0].filter((t) => t !== 'Widget').sort(), ['FreeText', 'Highlight', 'Ink', 'Square', 'Text']);

    await open(out);
    assert.equal(await page.locator('.doc-tab').count(), 2, 'second file opens in a new tab');
    assert.equal(await count('.annot'), 5, 'annotations come back editable');
    assert.equal(await count('.annot-markup'), 1);
  });

  test('comments panel shows replies and they survive saving', async () => {
    await page.click('.sidebar .tab[title="Comments"]');
    const card = page.locator('.viewer-slot ~ * .comment-card, .comment-card').filter({ hasText: 'Highlight' }).first();
    await card.locator('.comment-text').fill('Check this');
    await card.locator('.comment-text').blur();
    await card.locator('.reply-input').fill('Agreed');
    await card.locator('.reply-input').press('Enter');
    assert.ok(await page.locator('.reply-text', { hasText: 'Agreed' }).isVisible());
    const out = await save('comments.pdf');
    await open(out);
    await page.click('.sidebar .tab[title="Comments"]');
    assert.equal(await page.locator('.comment-card .reply-text', { hasText: 'Agreed' }).count(), 1);
    assert.equal(await page.locator('.comment-card .comment-text').evaluateAll((els) => els.some((e) => e.value === 'Check this')), true);
    await page.click('.sidebar .tab[title="Pages"]');
  });

  test('tabs can be switched and closed', async () => {
    const tabs = page.locator('.doc-tab');
    const n = await tabs.count();
    await tabs.first().click();
    assert.match(await tabs.first().getAttribute('class'), /active/);
    await page.keyboard.press('Control+Tab');
    assert.match(await tabs.nth(1).getAttribute('class'), /active/);
    for (let i = n; i > 1; i--) {
      await page.keyboard.press('Control+w');
      const dlg = page.locator('.modal button', { hasText: "Don't Save" });
      await dlg.waitFor({ timeout: 1500 }).then(() => dlg.click(), () => {});
    }
    assert.equal(await page.locator('.doc-tab').count(), 1);
  });

  test('form fields: fill existing and create new ones', async () => {
    await page.fill('.viewer-slot .annotationLayer input', 'Banko');
    await page.locator('.viewer-slot .annotationLayer input').blur();
    await page.keyboard.press('f');
    await drag(await at(0.5, 0.7), await at(0.75, 0.73));
    await page.fill('.propsbar input.prop-input', 'email');
    await page.locator('.propsbar input.prop-input').press('Enter');
    await page.locator('.propsbar input.prop-input').blur();
    const out = await save('form.pdf');
    const form = (await PDFDocument.load(readFileSync(out))).getForm();
    assert.equal(form.getTextField('name').getText(), 'Banko');
    assert.ok(form.getTextField('email'));
  });

  test('header, footer and watermark are written', async () => {
    await page.evaluate(() => document.querySelector('[title="More tools"]').click());
    await page.click('.ctx-menu >> text=Header & footer…');
    await page.click('.modal button.primary');
    await page.evaluate(() => document.querySelector('[title="More tools"]').click());
    await page.click('.ctx-menu >> text=Watermark…');
    await page.click('.modal button.primary');
    const out = await save('decor.pdf');
    const { pages } = await pdfText(out);
    assert.match(pages[1], /Page 2 of 3/);
    assert.match(pages[0], /CONFIDENTIAL/);
  });

  test('bookmarks can be added and are saved', async () => {
    await page.keyboard.press('Control+b');
    await page.keyboard.type('Intro');
    await page.keyboard.press('Enter');
    const out = await save('outline.pdf');
    const { outline } = await pdfText(out);
    assert.equal(outline[0]?.title, 'Intro');
    await page.click('.sidebar .tab[title="Pages"]');
  });

  test('edit text replaces a line of page text', async () => {
    await page.keyboard.press('e');
    const span = firstPage().locator('.textLayer span', { hasText: 'Secret code' }).first();
    await span.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Public code 1234');
    await page.keyboard.press('Escape');
    const out = await save('edited.pdf');
    const { pages } = await pdfText(out);
    assert.match(pages[0], /Public code 1234/);
  });

  test('stamps are placed and saved as Stamp annotations', async () => {
    await page.keyboard.press('k');
    await page.locator('.stamp-tile').first().click();
    await page.mouse.click(...(await at(0.7, 0.85)));
    assert.equal(await count('.annot-stamp'), 1);
    const out = await save('stamp.pdf');
    const { annots } = await pdfText(out);
    assert.ok(annots[0].includes('Stamp'));
  });

  test('redaction removes text from the file', async () => {
    await page.keyboard.press('Escape');
    await page.keyboard.press('x');
    await selectText('Needle 1');
    await selectText('4711');
    assert.equal(await count('.annot-redact'), 2);
    await page.evaluate(() => document.querySelector('[title="More tools"]').click());
    await page.click('.ctx-menu >> text=Apply redactions…');
    await page.click('.modal button.primary');
    await page.waitForSelector('.toast.show >> text=/Redacted|failed/', { timeout: 20000 });
    assert.match(await page.locator('.toast').textContent(), /Redacted 1 page/);
    assert.equal(await count('.annot-redact'), 0);
    const out = await save('redacted.pdf');
    const { pages } = await pdfText(out);
    assert.doesNotMatch(pages[0], /Needle 1/);
    assert.doesNotMatch(pages[0], /4711/, 'canary string must be gone from the file content');
    assert.match(pages[0], /heading/, 'text outside the redaction stays searchable');
    assert.match(pages[1], /Needle 2/, 'other pages untouched');
  });

  test('layouts, night mode, rulers, measure and undo', async () => {
    await page.selectOption('.layout-select', 'facing');
    const tops = await page.locator('.viewer-slot .pdfViewer .page').evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().top));
    assert.equal(Math.round(tops[0]), Math.round(tops[1]), 'two pages side by side');
    await page.selectOption('.layout-select', 'single');
    assert.equal(await page.locator('.viewer-slot .pdfViewer .page:visible').count(), 1);
    await page.selectOption('.layout-select', 'continuous');
    await page.click('[title="Night mode pages"]');
    assert.ok(await page.evaluate(() => document.body.classList.contains('night-pages')));
    await page.click('[title="Night mode pages"]');
    await page.keyboard.press('Control+r');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.main.with-rulers').count(), 1);
    await page.keyboard.press('Control+r');
    await page.keyboard.press('m');
    const before = await count('.annot');
    await drag(await at(0.1, 0.9), await at(0.5, 0.9));
    assert.equal(await count('.annot'), before + 1);
    assert.match(await page.locator('.viewer-slot .measure-label').first().textContent(), /mm/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    assert.equal(await count('.annot'), before);
    await page.keyboard.press('Control+Shift+z');
    assert.equal(await count('.annot'), before + 1);
  });

  test('no runtime errors', () => {
    assert.deepEqual(errors, []);
  });
});
