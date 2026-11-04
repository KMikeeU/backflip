import fontkit from '@pdf-lib/fontkit';
import {
  type Color,
  concatTransformationMatrix,
  degrees,
  drawEllipse,
  drawImage,
  drawLine,
  drawLinesOfText,
  drawRectangle,
  drawSvgPath,
  drawText,
  LineCapStyle,
  PDFDict,
  PDFDocument,
  type PDFFont,
  PDFHexString,
  type PDFImage,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObjectCopier,
  type PDFOperator,
  type PDFPage,
  PDFRef,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  StandardFonts,
} from 'pdf-lib';
import {
  type Annot,
  arrowHead,
  bbox,
  type FieldAnnot,
  type FontName,
  inkPath,
  LINE_HEIGHT,
  lineLength,
  measureTicks,
  NOTE_SIZE,
  stampLayout,
} from './annots';
import { decorations } from './decor';
import { rotVec } from './geom';
import type { DocModel, OutlineNode, PageItem } from './model';
import { availableTools, native } from './native';
import { EDITOR_DATA_KEY } from './pdfimport';
import { formatLength, settings } from './settings';

export interface BuildOptions {
  /** Draw everything into page content instead of writing annotations. */
  flatten?: boolean;
  /** Printing: flatten and leave out comment icons and redaction marks. */
  print?: boolean;
  /** Skip password protection (e.g. for printing or before signing). */
  noSecurity?: boolean;
}

function parseColor(hex: string) {
  let m = hex.replace('#', '');
  if (m.length <= 4) m = [...m].map((c) => c + c).join('');
  const n = (i: number) => parseInt(m.slice(i, i + 2), 16) / 255;
  return { color: rgb(n(0), n(2), n(4)), comps: [n(0), n(2), n(4)], alpha: m.length >= 8 ? n(6) : 1 };
}

const STD: Record<FontName, [StandardFonts, StandardFonts]> = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
};

class Fonts {
  private cache = new Map<string, PDFFont>();
  private unicode: PDFFont | null | undefined;
  constructor(private doc: PDFDocument) {}

  async get(name: FontName, text: string, bold = false): Promise<{ font: PDFFont; text: string }> {
    const std = STD[name][bold ? 1 : 0];
    let font = this.cache.get(std);
    if (!font) {
      font = await this.doc.embedFont(std);
      this.cache.set(std, font);
    }
    if (encodable(font, text)) return { font, text };
    // Standard fonts only cover WinAnsi; fall back to a system Unicode font when the text needs it.
    if (this.unicode === undefined) {
      const bytes = await native?.readSystemFont();
      this.unicode = null;
      if (bytes) {
        try {
          this.doc.registerFontkit(fontkit);
          this.unicode = await this.doc.embedFont(bytes, { subset: true });
        } catch (e) {
          console.warn('unicode font embed failed', e);
        }
      }
    }
    if (this.unicode && encodable(this.unicode, text)) return { font: this.unicode, text };
    return { font, text: [...text].map((c) => (c === '\n' || encodable(font, c) ? c : '?')).join('') };
  }
}

function encodable(font: PDFFont, text: string) {
  try {
    font.encodeText(text.replace(/\n/g, ''));
    return true;
  } catch {
    return false;
  }
}

/** Resource registry: page resources when flattening, a private dict for appearance streams. */
interface Res {
  font(f: PDFFont): PDFName;
  gs(p: { ca?: number; CA?: number; BM?: string }): PDFName;
  xobject(ref: PDFRef): PDFName;
}

class PageRes implements Res {
  private seen = new Map<string, PDFName>();
  constructor(
    private page: PDFPage,
    private doc: PDFDocument,
  ) {}
  font(f: PDFFont) {
    const k = `f${f.ref.toString()}`;
    let n = this.seen.get(k);
    if (!n) this.seen.set(k, (n = this.page.node.newFontDictionary('PEF', f.ref)));
    return n;
  }
  gs(p: { ca?: number; CA?: number; BM?: string }) {
    const k = `g${JSON.stringify(p)}`;
    let n = this.seen.get(k);
    if (!n) this.seen.set(k, (n = this.page.node.newExtGState('PEG', this.doc.context.obj(gsDict(p)))));
    return n;
  }
  xobject(ref: PDFRef) {
    const k = `x${ref.toString()}`;
    let n = this.seen.get(k);
    if (!n) this.seen.set(k, (n = this.page.node.newXObject('PEX', ref)));
    return n;
  }
}

class DictRes implements Res {
  fonts: Record<string, PDFRef> = {};
  states: Record<string, ReturnType<typeof gsDict>> = {};
  xobjects: Record<string, PDFRef> = {};
  private n = 0;
  font(f: PDFFont) {
    const k = Object.keys(this.fonts).find((x) => this.fonts[x] === f.ref) ?? `F${this.n++}`;
    this.fonts[k] = f.ref;
    return PDFName.of(k);
  }
  gs(p: { ca?: number; CA?: number; BM?: string }) {
    const k = `G${this.n++}`;
    this.states[k] = gsDict(p);
    return PDFName.of(k);
  }
  xobject(ref: PDFRef) {
    const k = `X${this.n++}`;
    this.xobjects[k] = ref;
    return PDFName.of(k);
  }
  toObj() {
    return { Font: this.fonts, ExtGState: this.states, XObject: this.xobjects };
  }
}

function gsDict(p: { ca?: number; CA?: number; BM?: string }) {
  const d: Record<string, number | PDFName> = {};
  if (p.ca !== undefined) d.ca = p.ca;
  if (p.CA !== undefined) d.CA = p.CA;
  if (p.BM) d.BM = PDFName.of(p.BM);
  return d;
}

const ZERO = degrees(0);

interface Ctx {
  out: PDFDocument;
  model: DocModel;
  fonts: Fonts;
  images: Map<string, PDFImage>;
  pageRot: number;
}

async function textOps(ctx: Ctx, res: Res, opts: { text: string; font: FontName; bold?: boolean; size: number; x: number; y: number; rot: number; color: Color; gs?: PDFName }) {
  const { font, text } = await ctx.fonts.get(opts.font, opts.text, opts.bold);
  const name = res.font(font);
  return drawLinesOfText(
    text.split('\n').map((l) => font.encodeText(l)),
    { x: opts.x, y: opts.y, size: opts.size, font: name, color: opts.color, lineHeight: opts.size * LINE_HEIGHT, rotate: degrees(opts.rot), xSkew: ZERO, ySkew: ZERO, graphicsState: opts.gs },
  );
}

/** Operators drawing an annotation in page user space. */
async function paint(ctx: Ctx, a: Annot, res: Res): Promise<PDFOperator[]> {
  const { color, alpha } = parseColor(a.color);
  switch (a.type) {
    case 'rect':
    case 'ellipse': {
      const fill = a.fill ? parseColor(a.fill) : null;
      const common = {
        borderColor: color,
        borderWidth: a.width,
        color: fill?.color,
        graphicsState: fill && fill.alpha < 1 ? res.gs({ ca: fill.alpha, CA: alpha }) : alpha < 1 ? res.gs({ CA: alpha }) : undefined,
      };
      if (a.type === 'rect') return drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, rotate: ZERO, xSkew: ZERO, ySkew: ZERO, ...common });
      return drawEllipse({ x: a.x + a.w / 2, y: a.y + a.h / 2, xScale: a.w / 2, yScale: a.h / 2, ...common });
    }
    case 'whiteout':
      return drawRectangle({ x: a.x, y: a.y, width: a.w, height: a.h, color, borderColor: undefined, borderWidth: 0, rotate: ZERO, xSkew: ZERO, ySkew: ZERO });
    case 'redact':
      return a.rects.flatMap((r) =>
        drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: rgb(0.88, 0.11, 0.28), borderColor: rgb(0.88, 0.11, 0.28), borderWidth: 1, rotate: ZERO, xSkew: ZERO, ySkew: ZERO, graphicsState: res.gs({ ca: 0.18 }) }),
      );
    case 'markup': {
      const gs = a.kind === 'highlight' ? res.gs({ ca: 0.4, BM: 'Multiply' }) : undefined;
      return a.rects.flatMap((r) => {
        if (a.kind === 'highlight')
          return drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color, borderColor: undefined, borderWidth: 0, rotate: ZERO, xSkew: ZERO, ySkew: ZERO, graphicsState: gs });
        const t = Math.max(0.6, r.h * 0.07);
        const y = a.kind === 'underline' ? r.y + t : r.y + r.h * 0.42;
        return drawRectangle({ x: r.x, y: y - t / 2, width: r.w, height: t, color, borderColor: undefined, borderWidth: 0, rotate: ZERO, xSkew: ZERO, ySkew: ZERO });
      });
    }
    case 'ink':
      // drawSvgPath flips Y (SVG is y-down), so feed it negated coordinates.
      return drawSvgPath(inkPath(a.strokes, -1), {
        x: 0,
        y: 0,
        scale: 1,
        color: undefined,
        borderColor: color,
        borderWidth: a.width,
        borderLineCap: LineCapStyle.Round,
        graphicsState: a.opacity < 1 ? res.gs({ CA: a.opacity }) : undefined,
      });
    case 'line': {
      const end = a.arrow ? arrowHead(a).shaftEnd : [a.x2, a.y2];
      const ops = drawLine({ start: { x: a.x1, y: a.y1 }, end: { x: end[0], y: end[1] }, thickness: a.width, color, lineCap: LineCapStyle.Round });
      if (a.arrow) {
        const { tri } = arrowHead(a);
        const d = `M${tri[0][0]} ${-tri[0][1]} L${tri[1][0]} ${-tri[1][1]} L${tri[2][0]} ${-tri[2][1]} Z`;
        ops.push(...drawSvgPath(d, { x: 0, y: 0, scale: 1, color, borderColor: undefined, borderWidth: 0 }));
      }
      if (a.measure) {
        for (const [p, q] of measureTicks(a)) ops.push(...drawLine({ start: { x: p[0], y: p[1] }, end: { x: q[0], y: q[1] }, thickness: a.width, color }));
        const label = formatLength(lineLength(a));
        const { font } = await ctx.fonts.get('Helvetica', label);
        const w = font.widthOfTextAtSize(label, 10);
        const [dx, dy] = rotVec(-w / 2, 4, ctx.pageRot);
        ops.push(...(await textOps(ctx, res, { text: label, font: 'Helvetica', size: 10, x: (a.x1 + a.x2) / 2 + dx, y: (a.y1 + a.y2) / 2 + dy, rot: ctx.pageRot, color })));
      }
      return ops;
    }
    case 'text': {
      const ops: PDFOperator[] = [];
      if (a.bg)
        ops.push(...drawRectangle({ x: a.bg.x, y: a.bg.y, width: a.bg.w, height: a.bg.h, color: parseColor(a.bg.color).color, borderColor: undefined, borderWidth: 0, rotate: ZERO, xSkew: ZERO, ySkew: ZERO }));
      ops.push(...(await textOps(ctx, res, { text: a.text, font: a.font, size: a.size, x: a.x, y: a.y, rot: a.rot, color })));
      return ops;
    }
    case 'image': {
      const asset = ctx.model.images.get(a.img);
      if (!asset) return [];
      let img = ctx.images.get(a.img);
      if (!img) {
        img = asset.mime === 'image/png' ? await ctx.out.embedPng(asset.bytes) : await ctx.out.embedJpg(asset.bytes);
        ctx.images.set(a.img, img);
      }
      const r = ((a.rot % 360) + 360) % 360;
      const [w, h] = r % 180 ? [a.h, a.w] : [a.w, a.h];
      const anchor = ({ 0: [a.x, a.y], 90: [a.x + a.w, a.y], 180: [a.x + a.w, a.y + a.h], 270: [a.x, a.y + a.h] } as Record<number, number[]>)[r] ?? [a.x, a.y];
      return drawImage(res.xobject(img.ref), { x: anchor[0], y: anchor[1], width: w, height: h, rotate: degrees(r), xSkew: ZERO, ySkew: ZERO });
    }
    case 'stamp': {
      const L = stampLayout(a);
      const rad = (a.rot * Math.PI) / 180;
      const c = Math.cos(rad),
        s = Math.sin(rad);
      const bw = L.border;
      const x0 = -L.sw / 2 + bw / 2,
        y0 = -L.sh / 2 + bw / 2,
        w = L.sw - bw,
        h = L.sh - bw,
        r = Math.min(L.radius, w / 2, h / 2);
      const path = `M${x0 + r} ${y0} H${x0 + w - r} Q${x0 + w} ${y0} ${x0 + w} ${y0 + r} V${y0 + h - r} Q${x0 + w} ${y0 + h} ${x0 + w - r} ${y0 + h} H${x0 + r} Q${x0} ${y0 + h} ${x0} ${y0 + h - r} V${y0 + r} Q${x0} ${y0} ${x0 + r} ${y0} Z`;
      const ops: PDFOperator[] = [pushGraphicsState(), concatTransformationMatrix(c, s, -s, c, a.x + a.w / 2, a.y + a.h / 2)];
      ops.push(...drawSvgPath(path, { x: 0, y: 0, scale: 1, color, borderColor: undefined, borderWidth: 0, graphicsState: res.gs({ ca: 0.08 }) }));
      ops.push(...drawSvgPath(path, { x: 0, y: 0, scale: 1, color: undefined, borderColor: color, borderWidth: bw }));
      for (const [str, size, y] of [
        [a.label, L.labelSize, L.labelY],
        ...(a.sub ? [[a.sub, L.subSize, L.subY]] : []),
      ] as [string, number, number][]) {
        const { font, text } = await ctx.fonts.get('Helvetica', str, true);
        const tw = font.widthOfTextAtSize(text, size);
        ops.push(...drawText(font.encodeText(text), { x: -tw / 2, y: -y, size, font: res.font(font), color, rotate: ZERO, xSkew: ZERO, ySkew: ZERO }));
      }
      ops.push(popGraphicsState());
      return ops;
    }
    default:
      return [];
  }
}

const SUBTYPE: Partial<Record<Annot['type'], string>> = {
  rect: 'Square',
  ellipse: 'Circle',
  ink: 'Ink',
  line: 'Line',
  text: 'FreeText',
  image: 'Stamp',
  stamp: 'Stamp',
  redact: 'Redact',
};

function quadPoints(rects: { x: number; y: number; w: number; h: number }[]) {
  return rects.flatMap((r) => [r.x, r.y + r.h, r.x + r.w, r.y + r.h, r.x, r.y, r.x + r.w, r.y]);
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function editorData(model: DocModel, a: Annot) {
  const data: Record<string, unknown> = { ...a };
  if (a.type === 'image') {
    const asset = model.images.get(a.img);
    // Embedding the source image doubles its size in the file; only do it for small images such as signatures.
    if (asset && asset.bytes.length < 1_500_000) {
      data.imgData = toBase64(asset.bytes);
      data.imgMime = asset.mime;
    }
  }
  return PDFHexString.fromText(JSON.stringify(data));
}

async function writeAnnotation(ctx: Ctx, page: PDFPage, a: Annot): Promise<PDFRef | null> {
  const { out, model } = ctx;
  const { comps, alpha } = parseColor(a.color);
  const base: Record<string, unknown> = {
    Type: 'Annot',
    F: 4,
    NM: PDFHexString.fromText(a.id),
    C: comps,
    T: PDFHexString.fromText(a.author ?? ''),
    M: PDFString.fromDate(a.date ? new Date(a.date) : new Date()),
    [EDITOR_DATA_KEY]: editorData(model, a),
  };
  if (a.contents) base.Contents = PDFHexString.fromText(a.contents);

  let dict: Record<string, unknown>;
  if (a.type === 'note') {
    dict = { ...base, Subtype: 'Text', Rect: [a.x, a.y - NOTE_SIZE, a.x + NOTE_SIZE, a.y], Contents: PDFHexString.fromText(a.text), Name: 'Comment', Open: false };
  } else {
    const subtype =
      a.type === 'markup' ? ({ highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' } as const)[a.kind] : SUBTYPE[a.type];
    if (!subtype) return null;
    const b = bbox(a);
    const pad = ('width' in a ? (a.width as number) : 0) + 2;
    const rect = [b.x - pad, b.y - pad, b.x + b.w + pad, b.y + b.h + pad];
    const res = new DictRes();
    const ops = await paint(ctx, a, res);
    const ap = out.context.formXObject(ops, { BBox: rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: res.toObj() });
    dict = { ...base, Subtype: subtype, Rect: rect, AP: { N: out.context.register(ap) } };
    if (alpha < 1) dict.CA = alpha;
    switch (a.type) {
      case 'markup':
      case 'redact':
        dict.QuadPoints = quadPoints(a.rects);
        if (a.type === 'markup' && a.kind === 'highlight') dict.CA = 0.4;
        break;
      case 'ink':
        dict.InkList = a.strokes;
        dict.BS = { W: a.width };
        if (a.opacity < 1) dict.CA = a.opacity;
        break;
      case 'rect':
      case 'ellipse':
        dict.BS = { W: a.width };
        if (a.fill) dict.IC = parseColor(a.fill).comps;
        break;
      case 'line':
        dict.L = [a.x1, a.y1, a.x2, a.y2];
        dict.BS = { W: a.width };
        dict.LE = [PDFName.of('None'), PDFName.of(a.arrow ? 'OpenArrow' : 'None')];
        if (a.measure) {
          dict.IT = 'LineDimension';
          dict.Contents = PDFHexString.fromText(formatLength(lineLength(a)));
        }
        break;
      case 'text': {
        const fontKey = { Helvetica: 'Helv', Times: 'TiRo', Courier: 'Cour' }[a.font];
        dict.DA = PDFString.of(`/${fontKey} ${a.size} Tf ${comps.map((v) => v.toFixed(3)).join(' ')} rg`);
        dict.Contents = PDFHexString.fromText(a.text);
        dict.C = [];
        if (a.rot) dict.Rotate = a.rot;
        break;
      }
      case 'stamp':
        dict.Name = PDFName.of(a.label.replace(/[^A-Za-z]/g, '') || 'Draft');
        dict.Contents = PDFHexString.fromText(a.sub ? `${a.label} — ${a.sub}` : a.label);
        break;
      case 'image':
        dict.Name = PDFName.of('Image');
        break;
    }
  }
  const ref = out.context.register(out.context.obj(dict as never));
  page.node.addAnnot(ref);
  for (const r of a.replies ?? []) {
    const rd = out.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: (dict.Rect as number[]) ?? [0, 0, 0, 0],
      IRT: ref,
      RT: PDFName.of('R'),
      F: 4 | 32,
      NM: PDFHexString.fromText(r.id),
      T: PDFHexString.fromText(r.author),
      M: PDFString.fromDate(new Date(r.date)),
      Contents: PDFHexString.fromText(r.text),
    } as never);
    page.node.addAnnot(out.context.register(rd));
  }
  return ref;
}

async function writeField(out: PDFDocument, page: PDFPage, a: FieldAnnot, radios: Map<string, ReturnType<ReturnType<PDFDocument['getForm']>['createRadioGroup']>>) {
  const form = out.getForm();
  const taken = (n: string) => {
    try {
      form.getField(n);
      return true;
    } catch {
      return false;
    }
  };
  let name = a.name.trim() || 'Field';
  if (a.kind !== 'radio') {
    const baseName = name;
    for (let i = 2; taken(name); i++) name = `${baseName}_${i}`;
  }
  const helv = await out.embedFont(StandardFonts.Helvetica);
  const opts = { x: a.x, y: a.y, width: a.w, height: a.h, rotate: degrees(a.rot), borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 1, backgroundColor: rgb(1, 1, 1) };
  switch (a.kind) {
    case 'text':
    case 'multiline': {
      const f = form.createTextField(name);
      if (a.kind === 'multiline') f.enableMultiline();
      f.addToPage(page, { ...opts, font: helv });
      f.setFontSize(a.fontSize);
      f.updateAppearances(helv);
      break;
    }
    case 'checkbox': {
      const f = form.createCheckBox(name);
      f.addToPage(page, opts);
      break;
    }
    case 'dropdown': {
      const f = form.createDropdown(name);
      f.setOptions(a.options.length ? a.options : ['Option 1']);
      f.addToPage(page, { ...opts, font: helv });
      f.setFontSize(a.fontSize);
      f.updateAppearances(helv);
      break;
    }
    case 'radio': {
      let g = radios.get(name);
      if (!g) {
        g = taken(name) ? form.getRadioGroup(name) : form.createRadioGroup(name);
        radios.set(name, g);
      }
      g.addOptionToPage(a.options[0] || `Choice ${g.getOptions().length + 1}`, page, opts);
      break;
    }
  }
}

/** Registers copied widgets with the output AcroForm so merged forms stay fillable. */
function adoptFormFields(out: PDFDocument, page: PDFPage, src: PDFDocument, adopted: Set<string>) {
  const annots = page.node.Annots();
  if (!annots) return;
  let form: ReturnType<PDFDocument['getForm']> | null = null;
  for (const o of annots.asArray()) {
    const d = out.context.lookup(o);
    if (!(d instanceof PDFDict) || d.lookup(PDFName.of('Subtype')) !== PDFName.of('Widget')) continue;
    let top: PDFRef | null = o instanceof PDFRef ? o : null;
    let cur: PDFDict = d;
    for (let guard = 0; guard < 20; guard++) {
      const parent = cur.get(PDFName.of('Parent'));
      if (!(parent instanceof PDFRef)) break;
      top = parent;
      cur = out.context.lookup(parent, PDFDict);
    }
    if (!top || adopted.has(top.toString())) continue;
    adopted.add(top.toString());
    form ??= out.getForm();
    form.acroForm.addField(top);
  }
  const srcAcro = src.catalog.lookup(PDFName.of('AcroForm'));
  const outAcro = out.catalog.lookup(PDFName.of('AcroForm'));
  if (srcAcro instanceof PDFDict && outAcro instanceof PDFDict && !outAcro.get(PDFName.of('DR'))) {
    const copier = PDFObjectCopier.for(src.context, out.context);
    const dr = srcAcro.get(PDFName.of('DR'));
    const da = srcAcro.get(PDFName.of('DA'));
    if (dr) outAcro.set(PDFName.of('DR'), copier.copy(dr));
    if (da) outAcro.set(PDFName.of('DA'), copier.copy(da));
  }
}

function writeOutline(out: PDFDocument, nodes: OutlineNode[], pageRef: (key: string) => PDFRef | null) {
  const ctx = out.context;
  const usable = (n: OutlineNode): OutlineNode | null => {
    const children = n.children.map(usable).filter((c): c is OutlineNode => !!c);
    if (!n.url && (!n.pageKey || !pageRef(n.pageKey)) && !children.length) return null;
    return { ...n, children };
  };
  const roots = nodes.map(usable).filter((n): n is OutlineNode => !!n);
  out.catalog.delete(PDFName.of('Outlines'));
  if (!roots.length) return;
  const rootRef = ctx.nextRef();
  const build = (list: OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let count = 0;
    list.forEach((n, i) => {
      const d: Record<string, unknown> = { Title: PDFHexString.fromText(n.title), Parent: parent };
      if (i > 0) d.Prev = refs[i - 1];
      if (i < list.length - 1) d.Next = refs[i + 1];
      const target = n.pageKey ? pageRef(n.pageKey) : null;
      if (target) d.Dest = [target, PDFName.of('XYZ'), PDFNull, n.y === null ? PDFNull : PDFNumber.of(n.y), PDFNull];
      else if (n.url) d.A = { S: 'URI', URI: PDFString.of(n.url) };
      if (n.children.length) {
        const sub = build(n.children, refs[i]);
        d.First = sub.first;
        d.Last = sub.last;
        d.Count = n.open ? sub.count : -sub.count;
        if (n.open) count += sub.count;
      }
      ctx.assign(refs[i], ctx.obj(d as never));
      count++;
    });
    return { first: refs[0], last: refs[refs.length - 1], count };
  };
  const top = build(roots, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last, Count: top.count }));
  out.catalog.set(PDFName.of('Outlines'), rootRef);
}

function stripMetadata(out: PDFDocument) {
  out.catalog.delete(PDFName.of('Metadata'));
  const info = out.context.lookup(out.context.trailerInfo.Info);
  if (info instanceof PDFDict) for (const k of info.keys()) info.delete(k);
}

async function sourceBytes(model: DocModel, src: number) {
  const s = model.sources[src];
  // Bake in filled-out form values through pdf.js; fall back to the original if that fails.
  if (s.doc.annotationStorage.size > 0) {
    try {
      return await s.doc.saveDocument();
    } catch (e) {
      console.warn('saveDocument failed, form values not included', e);
    }
  }
  return s.bytes;
}

export async function encrypt(model: DocModel, bytes: Uint8Array): Promise<Uint8Array> {
  const sec = model.security;
  if (!sec || (!sec.userPassword && !sec.ownerPassword)) return bytes;
  if (!(await availableTools()).qpdf) throw new Error('Password protection needs qpdf (pacman -S qpdf)');
  // An empty owner password would let anyone lift the restrictions, so generate one.
  const owner = sec.ownerPassword || crypto.randomUUID();
  return native!.qpdf(
    [
      '--encrypt',
      sec.userPassword,
      owner,
      '256',
      `--print=${sec.print ? 'full' : 'none'}`,
      `--modify=${sec.modify ? 'all' : 'none'}`,
      `--extract=${sec.copy ? 'y' : 'n'}`,
      `--annotate=${sec.annotate ? 'y' : 'n'}`,
      '--',
    ],
    bytes,
  );
}

export async function buildPdf(model: DocModel, pages: PageItem[] = model.pages, opts: BuildOptions = {}): Promise<Uint8Array> {
  const flatten = opts.print || opts.flatten || settings.saveMode === 'flatten';
  const used = [...new Set(pages.filter((p) => p.src >= 0).map((p) => p.src))];
  const libDocs = new Map<number, PDFDocument>();
  for (const src of used) {
    libDocs.set(src, await PDFDocument.load(await sourceBytes(model, src), { ignoreEncryption: true, updateMetadata: false }));
  }

  // Editing the original in place keeps forms, metadata, attachments and structure intact.
  const inPlace =
    used.length === 1 &&
    used[0] === 0 &&
    pages.length === libDocs.get(0)!.getPageCount() &&
    pages.every((p, i) => p.src === 0 && p.index === i);

  let out: PDFDocument;
  const outPages: PDFPage[] = [];
  if (inPlace) {
    out = libDocs.get(0)!;
    outPages.push(...out.getPages());
  } else {
    out = await PDFDocument.create({ updateMetadata: false });
    const first = libDocs.get(used[0] ?? -1);
    if (first) {
      out.setTitle(first.getTitle() ?? model.name.replace(/\.pdf$/i, ''));
      const author = first.getAuthor();
      if (author) out.setAuthor(author);
    }
    const adopted = new Set<string>();
    for (const p of pages) {
      if (p.src < 0) {
        const pg = out.addPage([p.view[2] - p.view[0], p.view[3] - p.view[1]]);
        pg.setMediaBox(p.view[0], p.view[1], p.view[2] - p.view[0], p.view[3] - p.view[1]);
        outPages.push(pg);
      } else {
        const src = libDocs.get(p.src)!;
        const [pg] = await out.copyPages(src, [p.index]);
        outPages.push(out.addPage(pg));
        adoptFormFields(out, pg, src, adopted);
      }
    }
  }
  if (!model.sanitize) {
    out.setProducer('PDF Editor');
    out.setModificationDate(new Date());
  }

  const ctx: Ctx = { out, model, fonts: new Fonts(out), images: new Map(), pageRot: 0 };
  const radios = new Map();
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pg = outPages[i];
    pg.setRotation(degrees(((p.rotation % 360) + 360) % 360));
    ctx.pageRot = p.rotation;
    const pageRes = new PageRes(pg, out);
    const flat: PDFOperator[] = [];
    for (const a of p.annots) {
      if (a.type === 'field') {
        await writeField(out, pg, a, radios);
        continue;
      }
      if (opts.print && (a.type === 'note' || a.type === 'redact')) continue;
      // Whiteouts and text edits replace page content, so they always go into the content stream.
      const intoContent = a.type === 'whiteout' || (a.type === 'text' && !!a.bg) || (flatten && a.type !== 'note' && a.type !== 'redact');
      if (intoContent) flat.push(...(await paint(ctx, a, pageRes)));
      else await writeAnnotation(ctx, pg, a);
    }
    const decor = decorations(model, p, i, pages.length, () => 0);
    if (decor.length) {
      const fontsFor = new Map<string, PDFFont>();
      for (const d of decor) fontsFor.set(d.font, (await ctx.fonts.get(d.font, d.text)).font);
      // Second layout pass with real font metrics so centred and right-aligned text lines up exactly.
      const items = decorations(model, p, i, pages.length, (t, f, s) => fontsFor.get(f)!.widthOfTextAtSize(t, s));
      for (const d of items) {
        const { color } = parseColor(d.color);
        flat.push(...(await textOps(ctx, pageRes, { text: d.text, font: d.font, size: d.size, x: d.x, y: d.y, rot: d.rot, color, gs: d.opacity < 1 ? pageRes.gs({ ca: d.opacity }) : undefined })));
      }
    }
    if (flat.length) pg.pushOperators(pushGraphicsState(), ...flat, popGraphicsState());
  }

  if (!inPlace || model.outlineEdited) {
    const refs = new Map(pages.map((p, i) => [p.key, outPages[i].ref]));
    writeOutline(out, model.outline, (k) => refs.get(k) ?? null);
  }
  if (model.sanitize) stripMetadata(out);

  const bytes = await out.save({ updateFieldAppearances: false });
  return opts.noSecurity || opts.print ? bytes : encrypt(model, bytes);
}

