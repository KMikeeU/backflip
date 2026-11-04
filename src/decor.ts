import { esc, FONT_CSS, type FontName } from './annots';
import { apply, invert, pageGeom, rotVec } from './geom';
import type { HeaderFooter, PageItem, Watermark } from './model';

export interface DecorItem {
  x: number;
  y: number;
  text: string;
  size: number;
  rot: number;
  color: string;
  opacity: number;
  font: FontName;
}

export interface DecorSource {
  headerFooter: HeaderFooter | null;
  watermark: Watermark | null;
  name: string;
}

export function fillTokens(s: string, page: number, total: number, file: string) {
  return s
    .replace(/\{page\}/g, String(page))
    .replace(/\{pages\}/g, String(total))
    .replace(/\{date\}/g, new Date().toLocaleDateString())
    .replace(/\{file\}/g, file.replace(/\.pdf$/i, ''));
}

/** Header/footer/watermark text runs for one page, in PDF user space, laid out against the page as displayed. */
export function decorations(
  src: DecorSource,
  page: PageItem,
  index: number,
  total: number,
  width: (text: string, font: FontName, size: number) => number,
): DecorItem[] {
  const out: DecorItem[] = [];
  const g = pageGeom(page.view, 1, page.rotation);
  const inv = invert(g.transform);
  const W = g.width,
    H = g.height;
  const hf = src.headerFooter;
  if (hf && !(hf.skipFirst && index === 0)) {
    const rows: [string[], number][] = [
      [hf.header, hf.margin + hf.size * 0.8],
      [hf.footer, H - hf.margin],
    ];
    for (const [cells, baseline] of rows) {
      cells.forEach((cell, col) => {
        if (!cell.trim()) return;
        const text = fillTokens(cell, index + hf.start, total + hf.start - 1, src.name);
        const w = width(text, hf.font, hf.size);
        const dx = col === 0 ? hf.margin : col === 1 ? W / 2 - w / 2 : W - hf.margin - w;
        const [x, y] = apply(inv, dx, baseline);
        out.push({ x, y, text, size: hf.size, rot: page.rotation, color: hf.color, opacity: 1, font: hf.font });
      });
    }
  }
  const wm = src.watermark;
  if (wm && wm.text.trim()) {
    const text = fillTokens(wm.text, index + 1, total, src.name);
    const w = width(text, wm.font, wm.size);
    const [cx, cy] = apply(inv, W / 2, H / 2);
    const rot = page.rotation + wm.angle;
    const dir = rotVec(1, 0, rot);
    const up = rotVec(0, 1, rot);
    out.push({
      x: cx - (dir[0] * w) / 2 - up[0] * wm.size * 0.35,
      y: cy - (dir[1] * w) / 2 - up[1] * wm.size * 0.35,
      text,
      size: wm.size,
      rot,
      color: wm.color,
      opacity: wm.opacity,
      font: wm.font,
    });
  }
  return out;
}

export function decorSvg(items: DecorItem[]) {
  return items
    .map(
      (d) =>
        `<g transform="translate(${d.x.toFixed(2)} ${d.y.toFixed(2)}) rotate(${d.rot}) scale(1 -1)"><text font-family="${FONT_CSS[d.font].replace(/"/g, "'")}" font-size="${d.size}" fill="${d.color}" fill-opacity="${d.opacity}" xml:space="preserve">${esc(d.text)}</text></g>`,
    )
    .join('');
}
