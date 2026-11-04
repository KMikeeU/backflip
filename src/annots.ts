import { type Box, type Pt, rotVec, unionBoxes } from './geom';
import { formatLength } from './settings';

export type FontName = 'Helvetica' | 'Times' | 'Courier';
export type MarkupKind = 'highlight' | 'underline' | 'strike';
export type FieldKind = 'text' | 'multiline' | 'checkbox' | 'radio' | 'dropdown';

export interface Reply {
  id: string;
  author: string;
  date: string;
  text: string;
}

interface Base {
  id: string;
  color: string;
  author?: string;
  date?: string;
  /** Comment text attached to the annotation (shown in the comments panel). */
  contents?: string;
  replies?: Reply[];
}
export interface TextAnnot extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  font: FontName;
  rot: number;
  /** Set by "Edit text": an opaque patch covering the original text it replaces. */
  bg?: Box & { color: string };
}
export interface NoteAnnot extends Base {
  type: 'note';
  x: number;
  y: number;
  text: string;
  rot: number;
}
export interface InkAnnot extends Base {
  type: 'ink';
  strokes: number[][];
  width: number;
  opacity: number;
}
export interface ShapeAnnot extends Base, Box {
  type: 'rect' | 'ellipse';
  width: number;
  fill: string | null;
}
export interface WhiteoutAnnot extends Base, Box {
  type: 'whiteout';
}
export interface MarkupAnnot extends Base {
  type: 'markup';
  kind: MarkupKind;
  rects: Box[];
  quote?: string;
}
export interface LineAnnot extends Base {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  arrow: boolean;
  measure?: boolean;
}
export interface ImageAnnot extends Base, Box {
  type: 'image';
  img: string;
  rot: number;
}
export interface RedactAnnot extends Base {
  type: 'redact';
  rects: Box[];
}
export interface StampAnnot extends Base, Box {
  type: 'stamp';
  label: string;
  sub?: string;
  rot: number;
}
export interface FieldAnnot extends Base, Box {
  type: 'field';
  kind: FieldKind;
  name: string;
  options: string[];
  fontSize: number;
  rot: number;
}

export type Annot =
  | TextAnnot
  | NoteAnnot
  | InkAnnot
  | ShapeAnnot
  | WhiteoutAnnot
  | MarkupAnnot
  | LineAnnot
  | ImageAnnot
  | RedactAnnot
  | StampAnnot
  | FieldAnnot;

export interface ImageAsset {
  id: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  url: string;
  w: number;
  h: number;
}

export const FONT_CSS: Record<FontName, string> = {
  Helvetica: "Helvetica, Arial, 'Liberation Sans', sans-serif",
  Times: "'Times New Roman', Times, 'Liberation Serif', serif",
  Courier: "'Courier New', Courier, 'Liberation Mono', monospace",
};
export const LINE_HEIGHT = 1.2;
export const ASCENT = 0.8;
const DESCENT = 0.22;
export const NOTE_SIZE = 20;

let uid = 0;
export const newId = () => `${Date.now().toString(36)}-${(uid++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const measureCtx = document.createElement('canvas').getContext('2d')!;
export function textWidth(s: string, font: FontName, size: number, bold = false) {
  measureCtx.font = `${bold ? 'bold ' : ''}100px ${FONT_CSS[font]}`;
  return (measureCtx.measureText(s).width / 100) * size;
}

export const TYPE_LABEL: Record<Annot['type'], string> = {
  text: 'Text',
  note: 'Comment',
  ink: 'Drawing',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  whiteout: 'Whiteout',
  markup: 'Markup',
  line: 'Line',
  image: 'Image',
  redact: 'Redaction',
  stamp: 'Stamp',
  field: 'Form field',
};

export function annotLabel(a: Annot) {
  if (a.type === 'markup') return { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough' }[a.kind];
  if (a.type === 'line') return a.measure ? 'Measurement' : a.arrow ? 'Arrow' : 'Line';
  if (a.type === 'text' && a.bg) return 'Text edit';
  return TYPE_LABEL[a.type];
}

/** Main visible text of an annotation, if any. */
export function annotText(a: Annot) {
  if (a.type === 'text' || a.type === 'note') return a.text;
  if (a.type === 'stamp') return a.label;
  if (a.type === 'field') return a.name;
  if (a.type === 'markup') return a.quote ?? '';
  if (a.type === 'line' && a.measure) return formatLength(lineLength(a));
  return '';
}

export const lineLength = (a: LineAnnot) => Math.hypot(a.x2 - a.x1, a.y2 - a.y1);

function rotatedBox(x: number, y: number, local: Box, rot: number): Box {
  const corners: Pt[] = (
    [
      [local.x, local.y],
      [local.x + local.w, local.y],
      [local.x, local.y + local.h],
      [local.x + local.w, local.y + local.h],
    ] as Pt[]
  ).map(([cx, cy]) => {
    const [rx, ry] = rotVec(cx, cy, rot);
    return [x + rx, y + ry];
  });
  return unionBoxes(corners.map(([px, py]) => ({ x: px, y: py, w: 0, h: 0 })));
}

export function bbox(a: Annot): Box {
  switch (a.type) {
    case 'text': {
      const lines = a.text.split('\n');
      const w = Math.max(4, ...lines.map((l) => textWidth(l, a.font, a.size)));
      const bottom = -(lines.length - 1) * a.size * LINE_HEIGHT - DESCENT * a.size;
      return rotatedBox(a.x, a.y, { x: 0, y: bottom, w, h: ASCENT * a.size - bottom }, a.rot);
    }
    case 'note':
      return rotatedBox(a.x, a.y, { x: 0, y: -NOTE_SIZE, w: NOTE_SIZE, h: NOTE_SIZE }, a.rot);
    case 'ink': {
      const pts: Box[] = [];
      for (const s of a.strokes) for (let i = 0; i < s.length; i += 2) pts.push({ x: s[i], y: s[i + 1], w: 0, h: 0 });
      const b = unionBoxes(pts);
      const p = a.width / 2;
      return { x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p };
    }
    case 'line': {
      const p = a.width / 2 + (a.arrow ? arrowLen(a) / 2 : 0) + (a.measure ? 6 : 0);
      return {
        x: Math.min(a.x1, a.x2) - p,
        y: Math.min(a.y1, a.y2) - p,
        w: Math.abs(a.x1 - a.x2) + 2 * p,
        h: Math.abs(a.y1 - a.y2) + 2 * p,
      };
    }
    case 'markup':
    case 'redact':
      return unionBoxes(a.rects);
    default:
      return { x: a.x, y: a.y, w: a.w, h: a.h };
  }
}

export function translate(a: Annot, dx: number, dy: number) {
  switch (a.type) {
    case 'ink':
      for (const s of a.strokes)
        for (let i = 0; i < s.length; i += 2) {
          s[i] += dx;
          s[i + 1] += dy;
        }
      break;
    case 'line':
      a.x1 += dx;
      a.x2 += dx;
      a.y1 += dy;
      a.y2 += dy;
      break;
    case 'markup':
    case 'redact':
      for (const r of a.rects) {
        r.x += dx;
        r.y += dy;
      }
      break;
    default:
      // The cover patch of an edited text stays over the original text it hides.
      a.x += dx;
      a.y += dy;
  }
}

export const canResize = (a: Annot) => a.type !== 'text' && a.type !== 'note';

export function setBox(a: Annot, from: Box, to: Box) {
  const fx = (x: number) => to.x + (from.w ? ((x - from.x) * to.w) / from.w : 0);
  const fy = (y: number) => to.y + (from.h ? ((y - from.y) * to.h) / from.h : 0);
  switch (a.type) {
    case 'ink':
      for (const s of a.strokes)
        for (let i = 0; i < s.length; i += 2) {
          s[i] = fx(s[i]);
          s[i + 1] = fy(s[i + 1]);
        }
      break;
    case 'line':
      [a.x1, a.y1, a.x2, a.y2] = [fx(a.x1), fy(a.y1), fx(a.x2), fy(a.y2)];
      break;
    case 'markup':
    case 'redact':
      for (const r of a.rects) {
        const x0 = fx(r.x),
          y0 = fy(r.y),
          x1 = fx(r.x + r.w),
          y1 = fy(r.y + r.h);
        Object.assign(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
      break;
    case 'text':
    case 'note':
      break;
    default:
      Object.assign(a, to);
  }
}

export function arrowLen(a: LineAnnot) {
  return Math.max(8, a.width * 4);
}

/** Triangle for the arrow head plus the point where the shaft should stop. */
export function arrowHead(a: LineAnnot): { tri: Pt[]; shaftEnd: Pt } {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const L = arrowLen(a);
  const spread = Math.PI / 7;
  const tri: Pt[] = [
    [a.x2, a.y2],
    [a.x2 - L * Math.cos(ang - spread), a.y2 - L * Math.sin(ang - spread)],
    [a.x2 - L * Math.cos(ang + spread), a.y2 - L * Math.sin(ang + spread)],
  ];
  const shaftEnd: Pt = [a.x2 - L * 0.8 * Math.cos(ang), a.y2 - L * 0.8 * Math.sin(ang)];
  return { tri, shaftEnd };
}

/** End ticks of a measurement line (perpendicular segments at both ends). */
export function measureTicks(a: LineAnnot): [Pt, Pt][] {
  const len = lineLength(a) || 1;
  const nx = (-(a.y2 - a.y1) / len) * 5;
  const ny = ((a.x2 - a.x1) / len) * 5;
  return [
    [
      [a.x1 - nx, a.y1 - ny],
      [a.x1 + nx, a.y1 + ny],
    ],
    [
      [a.x2 - nx, a.y2 - ny],
      [a.x2 + nx, a.y2 + ny],
    ],
  ];
}

export function inkPath(strokes: number[][], scaleY = 1) {
  let d = '';
  for (const pts of strokes) {
    if (pts.length < 2) continue;
    d += `M${f(pts[0])} ${f(pts[1] * scaleY)}`;
    if (pts.length === 2) d += ` L${f(pts[0] + 0.01)} ${f(pts[1] * scaleY)}`;
    for (let i = 2; i < pts.length; i += 2) d += ` L${f(pts[i])} ${f(pts[i + 1] * scaleY)}`;
    d += ' ';
  }
  return d.trim();
}

/** Stamp geometry in its own frame: origin at the centre, y pointing down, unrotated size sw×sh. */
export function stampLayout(a: StampAnnot) {
  const sw = a.rot % 180 ? a.h : a.w;
  const sh = a.rot % 180 ? a.w : a.h;
  const labelSize = a.sub ? sh * 0.42 : sh * 0.55;
  const subSize = sh * 0.19;
  const labelY = a.sub ? -sh / 2 + sh * 0.5 : labelSize * 0.36;
  const subY = sh / 2 - sh * 0.15;
  // Shrink text that would overflow after a resize to a narrow box.
  const fit = (s: string, size: number) => Math.min(size, ((sw - sh * 0.3) / Math.max(1, textWidth(s, 'Helvetica', 1, true))) * 0.98);
  return { sw, sh, labelSize: fit(a.label, labelSize), subSize: a.sub ? fit(a.sub, subSize) : subSize, labelY, subY, border: Math.max(1.5, sh * 0.06), radius: sh * 0.18 };
}

export function stampSize(label: string, sub: string | undefined, h = 34) {
  const lw = textWidth(label, 'Helvetica', (sub ? 0.42 : 0.55) * h, true);
  const sw = sub ? textWidth(sub, 'Helvetica', 0.19 * h, true) : 0;
  return { w: Math.max(lw, sw) + h * 0.7, h };
}

const f = (n: number) => +n.toFixed(2);
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function markupRectsSvg(a: MarkupAnnot) {
  return a.rects
    .map((r) => {
      if (a.kind === 'highlight')
        return `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="${a.color}" fill-opacity="0.4" style="mix-blend-mode:multiply"/>`;
      const t = Math.max(0.6, r.h * 0.07);
      const y = a.kind === 'underline' ? r.y + t : r.y + r.h * 0.42;
      return `<rect x="${f(r.x)}" y="${f(y - t / 2)}" width="${f(r.w)}" height="${f(t)}" fill="${a.color}"/>`;
    })
    .join('');
}

const upright = (x: number, y: number, rot: number) => `translate(${f(x)} ${f(y)}) rotate(${rot}) scale(1 -1)`;

/** SVG markup in PDF user space (to be placed inside a group carrying the page transform). */
export function annotSvg(a: Annot, images: Map<string, ImageAsset>, pageRot = 0): string {
  const attrs = `data-id="${a.id}" class="annot annot-${a.type}"`;
  switch (a.type) {
    case 'rect':
      return `<rect ${attrs} x="${f(a.x)}" y="${f(a.y)}" width="${f(a.w)}" height="${f(a.h)}" fill="${a.fill ?? 'none'}" stroke="${a.color}" stroke-width="${a.width}" pointer-events="visible"/>`;
    case 'ellipse':
      return `<ellipse ${attrs} cx="${f(a.x + a.w / 2)}" cy="${f(a.y + a.h / 2)}" rx="${f(a.w / 2)}" ry="${f(a.h / 2)}" fill="${a.fill ?? 'none'}" stroke="${a.color}" stroke-width="${a.width}" pointer-events="visible"/>`;
    case 'whiteout':
      return `<rect ${attrs} x="${f(a.x)}" y="${f(a.y)}" width="${f(a.w)}" height="${f(a.h)}" fill="${a.color}"/>`;
    case 'markup':
      return `<g ${attrs}>${markupRectsSvg(a)}${a.rects.map((r) => `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="transparent"/>`).join('')}</g>`;
    case 'redact':
      return `<g ${attrs}>${a.rects.map((r) => `<rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" fill="#e11d48" fill-opacity="0.18" stroke="#e11d48" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}</g>`;
    case 'ink':
      return `<path ${attrs} d="${inkPath(a.strokes)}" fill="none" stroke="${a.color}" stroke-width="${a.width}" stroke-opacity="${a.opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'line': {
      const hit = `<line x1="${f(a.x1)}" y1="${f(a.y1)}" x2="${f(a.x2)}" y2="${f(a.y2)}" stroke="transparent" stroke-width="${Math.max(8, a.width + 6)}"/>`;
      let body: string;
      if (a.arrow) {
        const { tri, shaftEnd } = arrowHead(a);
        body = `<line x1="${f(a.x1)}" y1="${f(a.y1)}" x2="${f(shaftEnd[0])}" y2="${f(shaftEnd[1])}" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round"/><polygon points="${tri.map((p) => p.map(f).join(',')).join(' ')}" fill="${a.color}"/>`;
      } else
        body = `<line x1="${f(a.x1)}" y1="${f(a.y1)}" x2="${f(a.x2)}" y2="${f(a.y2)}" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round"/>`;
      if (a.measure) {
        body += measureTicks(a)
          .map(([p, q]) => `<line x1="${f(p[0])}" y1="${f(p[1])}" x2="${f(q[0])}" y2="${f(q[1])}" stroke="${a.color}" stroke-width="${a.width}"/>`)
          .join('');
        const mx = (a.x1 + a.x2) / 2,
          my = (a.y1 + a.y2) / 2;
        body += `<g transform="${upright(mx, my, pageRot)}"><text class="measure-label" text-anchor="middle" y="-4" font-size="10" font-family="${FONT_CSS.Helvetica.replace(/"/g, "'")}" fill="${a.color}">${esc(formatLength(lineLength(a)))}</text></g>`;
      }
      return `<g ${attrs}>${hit}${body}</g>`;
    }
    case 'text': {
      const lh = a.size * LINE_HEIGHT;
      const spans = a.text
        .split('\n')
        .map((l, i) => `<tspan x="0" y="${f(i * lh)}">${esc(l) || ' '}</tspan>`)
        .join('');
      const b = bbox(a);
      const cover = a.bg ? `<rect x="${f(a.bg.x)}" y="${f(a.bg.y)}" width="${f(a.bg.w)}" height="${f(a.bg.h)}" fill="${a.bg.color}"/>` : '';
      return `<g ${attrs}>${cover}<rect x="${f(b.x)}" y="${f(b.y)}" width="${f(b.w)}" height="${f(b.h)}" fill="transparent"/><g transform="${upright(a.x, a.y, a.rot)}"><text font-family="${FONT_CSS[a.font].replace(/"/g, "'")}" font-size="${a.size}" fill="${a.color}" xml:space="preserve">${spans}</text></g></g>`;
    }
    case 'note':
      return `<g ${attrs} transform="${upright(a.x, a.y, a.rot)}"><title>${esc(a.text)}</title><path d="M2 2h16v12H8l-4 4v-4H2z" fill="${a.color}" stroke="#000" stroke-opacity=".5" stroke-width=".8" stroke-linejoin="round"/><path d="M5 6.5h10M5 9.5h7" stroke="#000" stroke-opacity=".55" stroke-width="1"/></g>`;
    case 'image': {
      const img = images.get(a.img);
      const sw = a.rot % 180 ? a.h : a.w;
      const sh = a.rot % 180 ? a.w : a.h;
      return `<g ${attrs} transform="${upright(a.x + a.w / 2, a.y + a.h / 2, a.rot)}"><image href="${img?.url ?? ''}" x="${f(-sw / 2)}" y="${f(-sh / 2)}" width="${f(sw)}" height="${f(sh)}" preserveAspectRatio="none"/></g>`;
    }
    case 'stamp': {
      const L = stampLayout(a);
      const bw = L.border;
      const font = FONT_CSS.Helvetica.replace(/"/g, "'");
      return `<g ${attrs} transform="${upright(a.x + a.w / 2, a.y + a.h / 2, a.rot)}"><rect x="${f(-L.sw / 2 + bw / 2)}" y="${f(-L.sh / 2 + bw / 2)}" width="${f(L.sw - bw)}" height="${f(L.sh - bw)}" rx="${f(L.radius)}" fill="${a.color}" fill-opacity="0.08" stroke="${a.color}" stroke-width="${f(bw)}"/><text text-anchor="middle" y="${f(L.labelY)}" font-size="${f(L.labelSize)}" font-weight="bold" font-family="${font}" fill="${a.color}">${esc(a.label)}</text>${a.sub ? `<text text-anchor="middle" y="${f(L.subY)}" font-size="${f(L.subSize)}" font-weight="bold" font-family="${font}" fill="${a.color}">${esc(a.sub)}</text>` : ''}</g>`;
    }
    case 'field': {
      const icon = a.kind === 'checkbox' ? '☐ ' : a.kind === 'radio' ? '◯ ' : a.kind === 'dropdown' ? '▾ ' : '';
      const size = Math.min(10, (a.rot % 180 ? a.w : a.h) * 0.6);
      return `<g ${attrs}><rect x="${f(a.x)}" y="${f(a.y)}" width="${f(a.w)}" height="${f(a.h)}" fill="#3b82f6" fill-opacity="0.12" stroke="#3b82f6" stroke-width="1" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/><g transform="${upright(a.x + a.w / 2, a.y + a.h / 2, a.rot)}"><text text-anchor="middle" y="${f(size * 0.35)}" font-size="${f(size)}" font-family="${FONT_CSS.Helvetica.replace(/"/g, "'")}" fill="#1d4ed8">${esc(icon + a.name)}</text></g></g>`;
    }
  }
}
