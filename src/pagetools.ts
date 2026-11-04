import {
  beginText,
  degrees,
  endText,
  PDFDocument,
  type PDFFont,
  type PDFPage,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  StandardFonts,
  TextRenderingMode,
} from 'pdf-lib';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { AnnotationMode } from 'pdfjs-dist';
import { type Annot, bbox, type ImageAnnot } from './annots';
import { apply, type Box, pageGeom } from './geom';
import type { DocModel, PageItem } from './model';
import { native } from './native';
import { loadPdf } from './pdf';
import type { TextIndex } from './search';

export interface TextRun {
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
  angle: number;
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Writes text with render mode 3 (invisible) so it is selectable and searchable but not drawn. */
function writeInvisibleText(page: PDFPage, font: PDFFont, runs: TextRun[]) {
  if (!runs.length) return;
  const name = page.node.newFontDictionary('PEO', font.ref);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  for (const r of runs) {
    let text = r.text;
    try {
      font.encodeText(text);
    } catch {
      text = [...text].map((c) => (/[\x20-\x7e\xa0-\xff]/.test(c) ? c : '?')).join('');
    }
    const natural = font.widthOfTextAtSize(text, r.size);
    if (!natural || !text.trim()) continue;
    const cos = Math.cos(r.angle),
      sin = Math.sin(r.angle);
    ops.push(
      setFontAndSize(name, r.size),
      setCharacterSqueeze(Math.max(1, Math.min(1000, (r.width / natural) * 100))),
      setTextMatrix(cos, sin, -sin, cos, r.x, r.y),
      showText(font.encodeText(text)),
    );
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

async function addSource(model: DocModel, bytes: Uint8Array, name: string) {
  const doc = await loadPdf(bytes, name);
  const id = model.sources.length;
  model.sources.push({ id, name, bytes, doc });
  return id;
}

/** Renders the page (content plus burned-in image annotations) at `scale` with rotation 0. */
async function rasterize(model: DocModel, page: PageItem, scale: number, images: ImageAnnot[], black: Box[] = []) {
  const g = pageGeom(page.view, scale, 0);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(g.width);
  canvas.height = Math.round(g.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.src >= 0) {
    const proxy = await model.sources[page.src].doc.getPage(page.index + 1);
    const vp = proxy.getViewport({ scale, rotation: 0 });
    // Burn in annotations and filled-in form values: they cannot be carried over onto the image page.
    await proxy.render({ canvas, canvasContext: ctx, viewport: vp, annotationMode: AnnotationMode.ENABLE_STORAGE }).promise;
  }
  for (const a of images) {
    const asset = model.images.get(a.img);
    if (!asset) continue;
    const bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }));
    const sw = a.rot % 180 ? a.h : a.w;
    const sh = a.rot % 180 ? a.w : a.h;
    const cx = a.x + a.w / 2,
      cy = a.y + a.h / 2;
    const rad = (a.rot * Math.PI) / 180;
    // Image corners in PDF space (top-left, top-right, bottom-left), then into canvas pixels.
    const pt = (u: number, v: number) => {
      const lx = (u - 0.5) * sw,
        ly = -(v - 0.5) * sh;
      return apply(g.transform, cx + lx * Math.cos(rad) - ly * Math.sin(rad), cy + lx * Math.sin(rad) + ly * Math.cos(rad));
    };
    const p0 = pt(0, 0),
      pu = pt(1, 0),
      pv = pt(0, 1);
    ctx.save();
    ctx.setTransform(pu[0] - p0[0], pu[1] - p0[1], pv[0] - p0[0], pv[1] - p0[1], p0[0], p0[1]);
    ctx.drawImage(bmp, 0, 0, 1, 1);
    ctx.restore();
    bmp.close();
  }
  ctx.fillStyle = '#000';
  for (const b of black) {
    const p1 = apply(g.transform, b.x, b.y);
    const p2 = apply(g.transform, b.x + b.w, b.y + b.h);
    ctx.fillRect(Math.min(p1[0], p2[0]) - 1, Math.min(p1[1], p2[1]) - 1, Math.abs(p2[0] - p1[0]) + 2, Math.abs(p2[1] - p1[1]) + 2);
  }
  return canvas;
}

async function canvasBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', q = 0.9) {
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), type, q));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Splits a text item into runs, dropping the characters that fall inside any redaction box. */
function survivingRuns(item: TextItem, boxes: Box[], font: PDFFont): TextRun[] {
  const [a, b, c, d, e, f] = item.transform;
  const size = Math.hypot(c, d) || item.height || 10;
  const angle = Math.atan2(b, a);
  const box: Box = { x: e, y: f - size * 0.25, w: item.width, h: size * 1.2 };
  const rotated = Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3;
  if (!boxes.some((r) => intersects(r, rotated ? { x: e - item.width, y: f - item.width, w: item.width * 2, h: item.width * 2 } : box)))
    return [{ text: item.str, x: e, y: f, size, width: item.width, angle }];
  if (rotated) return [];
  const chars = [...item.str];
  const widths = chars.map((ch) => {
    try {
      return font.widthOfTextAtSize(ch, size);
    } catch {
      return size * 0.5;
    }
  });
  const total = widths.reduce((s, w) => s + w, 0) || 1;
  const k = item.width / total;
  const runs: TextRun[] = [];
  let x = e;
  let cur: TextRun | null = null;
  chars.forEach((ch, i) => {
    const w = widths[i] * k;
    const hit = boxes.some((r) => intersects(r, { x, y: box.y, w, h: box.h }));
    if (hit) cur = null;
    else if (cur) {
      cur.text += ch;
      cur.width += w;
    } else runs.push((cur = { text: ch, x, y: f, size, width: w, angle: 0 }));
    x += w;
  });
  return runs;
}

/**
 * Applies redaction marks for real: affected pages are re-rendered with black boxes into a new
 * image-only page, and only the text outside the boxes is put back as invisible, searchable text.
 */
export async function applyRedactions(model: DocModel, index: TextIndex, progress: (msg: string) => void) {
  const targets = model.pages.filter((p) => p.annots.some((a) => a.type === 'redact'));
  if (!targets.length) return 0;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const updates: { page: PageItem; boxes: Box[]; burned: Set<string> }[] = [];
  for (const [n, page] of targets.entries()) {
    progress(`Redacting page ${model.pages.indexOf(page) + 1} (${n + 1} of ${targets.length})…`);
    const boxes = page.annots.flatMap((a) => (a.type === 'redact' ? a.rects : []));
    const hitImages = page.annots.filter((a): a is ImageAnnot => a.type === 'image' && boxes.some((b) => intersects(b, bbox(a))));
    const canvas = await rasterize(model, page, 250 / 72, hitImages, boxes);
    const [x0, y0, x1, y1] = page.view;
    const pg = out.addPage([x1 - x0, y1 - y0]);
    pg.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    const img = await out.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.92));
    pg.drawImage(img, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    const pt = await index.get(page.src, page.index);
    if (pt) {
      const items = pt.content.items.filter((i): i is TextItem => 'str' in i);
      writeInvisibleText(pg, font, items.flatMap((i) => survivingRuns(i, boxes, font)));
    }
    canvas.width = canvas.height = 0;
    updates.push({ page, boxes, burned: new Set(hitImages.map((i) => i.id)) });
  }
  const src = await addSource(model, await out.save(), 'redacted');
  model.edit('pages', () => {
    updates.forEach(({ page, boxes }, i) => {
      page.src = src;
      page.index = i;
      // Annotations inside a redacted area are part of what is being removed.
      page.annots = page.annots.filter((a: Annot) => a.type !== 'redact' && !boxes.some((b) => intersects(b, bbox(a))));
    });
  });
  return targets.length;
}

export async function pageHasText(index: TextIndex, page: PageItem) {
  const pt = await index.get(page.src, page.index);
  return !!pt && pt.text.replace(/\s/g, '').length > 10;
}

function parseTsv(tsv: string, scale: number, view: number[]): TextRun[] {
  const [, , , y1] = view;
  const x0 = view[0];
  const lines = new Map<string, { words: { text: string; l: number; t: number; w: number; h: number }[] }>();
  for (const row of tsv.split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const word = c.slice(11).join('\t').trim();
    if (!word || parseFloat(c[10]) < 0) continue;
    const key = `${c[2]}-${c[3]}-${c[4]}`;
    const line = lines.get(key) ?? { words: [] };
    line.words.push({ text: word, l: +c[6], t: +c[7], w: +c[8], h: +c[9] });
    lines.set(key, line);
  }
  const runs: TextRun[] = [];
  for (const { words } of lines.values()) {
    const bottom = Math.max(...words.map((w) => w.t + w.h));
    const top = Math.min(...words.map((w) => w.t));
    const lineH = (bottom - top) / scale;
    const size = Math.max(4, lineH * 0.85);
    const baseline = y1 - bottom / scale + lineH * 0.18;
    words.forEach((w, i) => {
      // Trailing space keeps words apart when the text is extracted or searched.
      const next = words[i + 1];
      const text = next ? `${w.text} ` : w.text;
      const width = (next ? next.l - w.l : w.w) / scale;
      runs.push({ text, x: x0 + w.l / scale, y: baseline, size, width: Math.max(1, width), angle: 0 });
    });
  }
  return runs;
}

/** Runs Tesseract on the pages and adds an invisible text layer, keeping the original page content. */
export async function ocrPages(model: DocModel, pages: PageItem[], lang: string, progress: (msg: string) => void) {
  if (!native) throw new Error('OCR requires the desktop app');
  const scale = 300 / 72;
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const libCache = new Map<number, PDFDocument>();
  const done: PageItem[] = [];
  for (const [n, page] of pages.entries()) {
    progress(`Recognizing text on page ${model.pages.indexOf(page) + 1} (${n + 1} of ${pages.length})…`);
    const images = page.annots.filter((a): a is ImageAnnot => a.type === 'image');
    const canvas = await rasterize(model, page, scale, images);
    const tsv = await native.ocr(await canvasBytes(canvas, 'image/png'), lang);
    canvas.width = canvas.height = 0;
    const runs = parseTsv(tsv, scale, page.view);
    let pg: PDFPage;
    if (page.src >= 0) {
      let lib = libCache.get(page.src);
      if (!lib) {
        lib = await PDFDocument.load(model.sources[page.src].bytes, { ignoreEncryption: true, updateMetadata: false });
        libCache.set(page.src, lib);
      }
      [pg] = await out.copyPages(lib, [page.index]);
      out.addPage(pg);
      pg.setRotation(degrees(0));
    } else {
      const [x0, y0, x1, y1] = page.view;
      pg = out.addPage([x1 - x0, y1 - y0]);
      pg.setMediaBox(x0, y0, x1 - x0, y1 - y0);
    }
    writeInvisibleText(pg, font, runs);
    done.push(page);
  }
  if (!done.length) return 0;
  const src = await addSource(model, await out.save(), 'ocr');
  model.edit('pages', () => done.forEach((p, i) => ((p.src = src), (p.index = i))));
  return done.length;
}
