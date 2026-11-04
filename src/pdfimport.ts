import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFRef,
  PDFString,
} from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDateString } from 'pdfjs-dist';
import { type Annot, ASCENT, type FontName, type ImageAsset, newId, type Reply } from './annots';
import { type Box, rotVec } from './geom';
import type { SignatureInfo } from './model';
import { availableTools, native } from './native';
import { loadPdf, makeImageAsset } from './pdf';
import { toast } from './ui';

/** Private key under which we store our own annotation model, for lossless round-trips. */
export const EDITOR_DATA_KEY = 'PDFEditorData';

export interface PreparedSource {
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
  annots: Map<number, Annot[]>;
  images: ImageAsset[];
  signatures: SignatureInfo[];
  password: string | null;
  wasEncrypted: boolean;
}

const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : 0);
const nums = (doc: PDFDocument, o: PDFObject | undefined): number[] => {
  const a = o instanceof PDFRef ? doc.context.lookup(o) : o;
  if (!(a instanceof PDFArray)) return [];
  return a.asArray().map((x) => num(x instanceof PDFRef ? doc.context.lookup(x) : x));
};
const text = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);

function hex(c: number[], fallback = '#000000') {
  if (!c.length) return fallback;
  let rgb: number[];
  if (c.length === 1) rgb = [c[0], c[0], c[0]];
  else if (c.length === 4) rgb = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  else rgb = c.slice(0, 3);
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
}

function pdfDate(s: string | undefined) {
  if (!s) return undefined;
  try {
    return PDFDateString.toDateObject(s)?.toISOString();
  } catch {
    return undefined;
  }
}

function quadRects(q: number[]): Box[] {
  const out: Box[] = [];
  for (let i = 0; i + 7 < q.length; i += 8) {
    const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
    const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
    const x = Math.min(...xs),
      y = Math.min(...ys);
    out.push({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y });
  }
  return out;
}

const FONT_MAP: [RegExp, FontName][] = [
  [/cour|mono/i, 'Courier'],
  [/times|tiro|serif/i, 'Times'],
];

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function convert(doc: PDFDocument, d: PDFDict, images: ImageAsset[]): Promise<Annot | null> {
  const get = (k: string) => d.get(PDFName.of(k));
  const lookup = (k: string) => {
    const v = get(k);
    return v instanceof PDFRef ? doc.context.lookup(v) : v;
  };
  const own = text(lookup(EDITOR_DATA_KEY));
  if (own) {
    try {
      const data = JSON.parse(own) as Annot & { imgData?: string; imgMime?: string };
      if (data.type === 'image' && data.imgData) {
        const asset = await makeImageAsset(b64ToBytes(data.imgData), data.imgMime);
        images.push(asset);
        data.img = asset.id;
        delete data.imgData;
        delete data.imgMime;
      } else if (data.type === 'image') return null;
      data.id = newId();
      // Replies are stored as separate /IRT annotations and re-attached below.
      delete data.replies;
      return data;
    } catch {
      /* fall through to generic conversion */
    }
  }

  const subtype = nameOf(lookup('Subtype'));
  const flags = num(lookup('F'));
  if (flags & 2) return null;
  const rect = nums(doc, get('Rect'));
  if (rect.length !== 4) return null;
  const [x1, y1, x2, y2] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const color = hex(nums(doc, get('C')), '#000000');
  const base = {
    id: newId(),
    color,
    author: text(lookup('T')),
    date: pdfDate(text(lookup('M')) ?? text(lookup('CreationDate'))),
    contents: text(lookup('Contents')) || undefined,
  };
  const bs = lookup('BS');
  const borderW = bs instanceof PDFDict ? (bs.get(PDFName.of('W')) ? num(bs.get(PDFName.of('W'))) : 1) : 1;
  const opacity = get('CA') ? num(lookup('CA')) : 1;

  switch (subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const rects = quadRects(nums(doc, get('QuadPoints')));
      const kind = subtype === 'Highlight' ? 'highlight' : subtype === 'StrikeOut' ? 'strike' : 'underline';
      return { ...base, type: 'markup', kind, rects: rects.length ? rects : [{ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }] };
    }
    case 'Redact': {
      const rects = quadRects(nums(doc, get('QuadPoints')));
      return { ...base, type: 'redact', rects: rects.length ? rects : [{ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }] };
    }
    case 'Ink': {
      const list = lookup('InkList');
      if (!(list instanceof PDFArray)) return null;
      const strokes = list.asArray().map((s) => nums(doc, s));
      return { ...base, type: 'ink', strokes, width: borderW || 1, opacity };
    }
    case 'Square':
    case 'Circle': {
      const ic = nums(doc, get('IC'));
      const rd = nums(doc, get('RD'));
      const inset = rd.length === 4 ? rd : [borderW / 2, borderW / 2, borderW / 2, borderW / 2];
      return {
        ...base,
        type: subtype === 'Square' ? 'rect' : 'ellipse',
        x: x1 + inset[0],
        y: y1 + inset[3],
        w: Math.max(1, x2 - x1 - inset[0] - inset[2]),
        h: Math.max(1, y2 - y1 - inset[1] - inset[3]),
        width: borderW,
        fill: ic.length ? hex(ic) + '33' : null,
      };
    }
    case 'Line': {
      const l = nums(doc, get('L'));
      if (l.length !== 4) return null;
      const le = lookup('LE');
      const ends = le instanceof PDFArray ? le.asArray().map((n) => nameOf(n)) : [];
      const arrow = /Arrow/.test(ends[1] ?? '') || /Arrow/.test(ends[0] ?? '');
      const measure = !!get('Measure') || nameOf(lookup('IT')) === 'LineDimension';
      return { ...base, type: 'line', x1: l[0], y1: l[1], x2: l[2], y2: l[3], width: borderW, arrow, measure };
    }
    case 'FreeText': {
      const da = text(lookup('DA')) ?? '';
      const fm = /\/(\S+)\s+([\d.]+)\s+Tf/.exec(da);
      const size = fm ? parseFloat(fm[2]) || 12 : 12;
      const font = FONT_MAP.find(([re]) => re.test(fm?.[1] ?? ''))?.[1] ?? 'Helvetica';
      const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      const g = /([\d.]+)\s+g(\s|$)/.exec(da);
      const tc = rg ? hex([+rg[1], +rg[2], +rg[3]]) : g ? hex([+g[1]]) : '#000000';
      const rot = ((num(lookup('Rotate')) % 360) + 360) % 360;
      const tl: Record<number, [number, number]> = { 0: [x1 + 2, y2 - 2], 90: [x1 + 2, y1 + 2], 180: [x2 - 2, y1 + 2], 270: [x2 - 2, y2 - 2] };
      const [tx, ty] = tl[rot] ?? tl[0];
      const [ox, oy] = rotVec(0, -ASCENT * size, rot);
      const body = (text(lookup('Contents')) ?? '').replace(/\r\n?/g, '\n');
      if (!body.trim()) return null;
      return { ...base, contents: undefined, type: 'text', x: tx + ox, y: ty + oy, text: body, size, font, rot, color: tc };
    }
    case 'Text':
      return { ...base, contents: undefined, type: 'note', x: x1, y: y2, text: text(lookup('Contents')) ?? '', rot: 0, color: color === '#000000' ? '#fbbf24' : color };
  }
  return null;
}

function readSignatures(doc: PDFDocument): SignatureInfo[] {
  const out: SignatureInfo[] = [];
  try {
    for (const field of doc.getForm().getFields()) {
      const d = field.acroField.dict;
      if (nameOf(d.lookup(PDFName.of('FT'))) !== 'Sig') continue;
      const v = d.lookup(PDFName.of('V'));
      if (!(v instanceof PDFDict)) continue;
      out.push({
        field: field.getName(),
        name: text(v.lookup(PDFName.of('Name'))),
        date: pdfDate(text(v.lookup(PDFName.of('M')))),
        reason: text(v.lookup(PDFName.of('Reason'))),
        location: text(v.lookup(PDFName.of('Location'))),
      });
    }
  } catch {
    /* malformed AcroForm: no signatures to report */
  }
  return out;
}

/**
 * Loads a PDF for editing: decrypts it (via qpdf when available) and lifts supported annotations
 * out of the file into the editable model, so they are not drawn twice and can be changed.
 */
export async function prepareSource(data: Uint8Array, name: string): Promise<PreparedSource> {
  let password: string | null = null;
  let doc = await loadPdf(data, name, (pw) => (password = pw));
  const result: PreparedSource = { bytes: data, doc, annots: new Map(), images: [], signatures: [], password, wasEncrypted: false };

  let lib: PDFDocument;
  try {
    lib = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch (e) {
    console.warn('pdf-lib could not parse; annotations stay read-only', e);
    return result;
  }
  let bytes = data;
  if (lib.isEncrypted) {
    result.wasEncrypted = true;
    result.password = password;
    if (!(await availableTools()).qpdf) {
      toast(native ? 'Install qpdf to edit encrypted PDFs (pacman -S qpdf)' : 'Encrypted PDFs can only be viewed in the browser version', 'error');
      return result;
    }
    try {
      bytes = await native!.qpdf(['--decrypt', `--password=${password ?? ''}`], data);
      lib = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    } catch (e) {
      toast(`Could not decrypt: ${(e as Error).message}`, 'error');
      return result;
    }
  }

  if (native) result.signatures = readSignatures(lib);

  let changed = bytes !== data;
  const pages = lib.getPages();
  for (let i = 0; i < pages.length; i++) {
    const annotsArr = pages[i].node.Annots();
    if (!annotsArr) continue;
    const entries = annotsArr.asArray().map((o) => ({ ref: o instanceof PDFRef ? o : null, dict: (o instanceof PDFRef ? lib.context.lookup(o) : o) as PDFObject }));
    const imported = new Map<PDFRef | PDFDict, Annot>();
    const remove = new Set<PDFObject>();
    for (const { ref, dict } of entries) {
      if (!(dict instanceof PDFDict)) continue;
      if (dict.get(PDFName.of('IRT'))) continue;
      const a = await convert(lib, dict, result.images).catch(() => null);
      if (!a) continue;
      imported.set(ref ?? dict, a);
      remove.add(ref ?? dict);
      const popup = dict.get(PDFName.of('Popup'));
      if (popup) remove.add(popup);
    }
    // Replies are Text annotations pointing at their parent through /IRT.
    for (const { ref, dict } of entries) {
      if (!(dict instanceof PDFDict)) continue;
      const irt = dict.get(PDFName.of('IRT'));
      const parent = irt && imported.get(irt as PDFRef);
      if (!parent) continue;
      const reply: Reply = {
        id: newId(),
        author: text(dict.lookup(PDFName.of('T'))) ?? '',
        date: pdfDate(text(dict.lookup(PDFName.of('M')))) ?? new Date().toISOString(),
        text: text(dict.lookup(PDFName.of('Contents'))) ?? '',
      };
      (parent.replies ??= []).push(reply);
      remove.add(ref ?? dict);
      const popup = dict.get(PDFName.of('Popup'));
      if (popup) remove.add(popup);
    }
    if (!remove.size) continue;
    const keep = annotsArr.asArray().filter((o) => !remove.has(o));
    pages[i].node.set(PDFName.of('Annots'), lib.context.obj(keep));
    result.annots.set(i, [...imported.values()]);
    changed = true;
  }

  if (!changed) return result;
  if (result.annots.size) bytes = await lib.save({ updateFieldAppearances: false });
  await doc.loadingTask.destroy();
  doc = await loadPdf(bytes, name);
  result.doc = doc;
  result.bytes = bytes;
  return result;
}
