import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import {
  type Annot,
  bbox,
  FONT_CSS,
  type FieldKind,
  type FontName,
  type ImageAnnot,
  type InkAnnot,
  LINE_HEIGHT,
  type MarkupKind,
  newId,
  type NoteAnnot,
  setBox,
  type StampAnnot,
  stampSize,
  type TextAnnot,
  textWidth,
  translate,
} from './annots';
import { type Box, boxFromPts, type Pt } from './geom';
import type { DocModel } from './model';
import type { TextIndex } from './search';
import { settings, UNIT_PT } from './settings';
import { h, toast } from './ui';
import type { PageView, Viewer } from './viewer';

export type Tool =
  | 'select'
  | 'hand'
  | 'text'
  | 'edittext'
  | 'note'
  | 'draw'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'measure'
  | 'whiteout'
  | 'redact'
  | 'field'
  | 'place'
  | 'pickrect';

export interface Style {
  textColor: string;
  inkColor: string;
  shapeColor: string;
  markColor: string;
  noteColor: string;
  inkWidth: number;
  shapeWidth: number;
  fontSize: number;
  font: FontName;
  fill: boolean;
  inkOpacity: number;
  fieldKind: FieldKind;
}

export const DEFAULT_STYLE: Style = {
  textColor: '#111111',
  inkColor: '#e11d48',
  shapeColor: '#2563eb',
  markColor: '#facc15',
  noteColor: '#fbbf24',
  inkWidth: 2,
  shapeWidth: 2,
  fontSize: 14,
  font: 'Helvetica',
  fill: false,
  inkOpacity: 1,
  fieldKind: 'text',
};

/** One style shared by every tab, so defaults follow the user across documents. */
export const sharedStyle: Style = { ...DEFAULT_STYLE, ...JSON.parse(localStorage.getItem('style') ?? '{}') };

export type Placing = { kind: 'image'; img: string; w: number; h: number } | { kind: 'stamp'; label: string; sub?: string; color: string };

/** Which style color key a tool or annotation uses. */
export function colorKey(t: Tool | Annot['type']): keyof Style | null {
  switch (t) {
    case 'text':
      return 'textColor';
    case 'draw':
    case 'ink':
      return 'inkColor';
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'arrow':
    case 'measure':
      return 'shapeColor';
    case 'highlight':
    case 'underline':
    case 'strike':
    case 'markup':
      return 'markColor';
    case 'note':
      return 'noteColor';
    default:
      return null;
  }
}

const MARKUP_TOOLS = ['highlight', 'underline', 'strike', 'redact'];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const SVG = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

interface SnapResult {
  delta: number;
  at: number | null;
}

export class Tools extends EventTarget {
  tool: Tool = 'select';
  style: Style = sharedStyle;
  placing: Placing | null = null;
  private clipboard: { annots: Annot[] } | null = null;
  private editor: { close: (commit: boolean) => void } | null = null;
  private markBar: HTMLElement;
  private lastInk: { id: string; at: number } | null = null;
  private rectPick: ((r: { view: PageView; box: Box } | null) => void) | null = null;

  constructor(
    private model: DocModel,
    private viewer: Viewer,
    private index: TextIndex,
  ) {
    super();
    const c = viewer.container;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('dblclick', (e) => this.onDblClick(e));
    c.addEventListener('pointerup', () => setTimeout(() => this.onSelectionDone(), 0));
    c.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        viewer.zoomStep(e.deltaY < 0 ? 1 : -1, e);
      },
      { passive: false },
    );
    this.markBar = h('div', { class: 'markbar' });
    document.body.append(this.markBar);
    document.addEventListener('selectionchange', () => {
      if (document.getSelection()?.isCollapsed) this.markBar.classList.remove('show');
    });
    this.applyToolClass();
  }

  destroy() {
    this.markBar.remove();
  }

  saveStyle() {
    localStorage.setItem('style', JSON.stringify(this.style));
  }

  setTool(t: Tool) {
    this.editor?.close(true);
    if (t !== 'place') this.placing = null;
    if (t !== 'pickrect' && this.rectPick) {
      this.rectPick(null);
      this.rectPick = null;
    }
    this.tool = t;
    if (t !== 'select') this.select([]);
    this.applyToolClass();
    this.dispatchEvent(new Event('toolchange'));
  }

  private applyToolClass() {
    const c = this.viewer.container;
    c.dataset.tool = this.tool;
    // These tools keep the pdf.js text layer reachable so text can be selected or picked.
    const passive = ['select', 'hand', 'edittext', ...MARKUP_TOOLS].includes(this.tool);
    c.classList.toggle('overlay-passive', passive);
  }

  get selection(): Annot[] {
    return [...this.viewer.selected].map((id) => this.model.findAnnot(id)?.annot).filter((a): a is Annot => !!a);
  }

  select(ids: string[]) {
    const same = ids.length === this.viewer.selected.size && ids.every((i) => this.viewer.selected.has(i));
    if (same) return;
    this.viewer.selected = new Set(ids);
    this.viewer.drawOverlays();
    this.dispatchEvent(new Event('selectionchange'));
  }

  /** Applies a style change to the tool defaults and to every selected annotation it is relevant to. */
  applyStyle(patch: Partial<Style>) {
    Object.assign(this.style, patch);
    this.saveStyle();
    const sel = this.selection;
    if (!sel.length) return;
    this.model.edit('annots', () => {
      for (const a of sel) {
        const ck = colorKey(a.type);
        for (const [k, v] of Object.entries(patch) as [keyof Style, never][]) {
          if (k === ck) a.color = v;
          if (k === 'fontSize' && a.type === 'text') a.size = v;
          if (k === 'fontSize' && a.type === 'field') a.fontSize = v;
          if (k === 'font' && a.type === 'text') a.font = v;
          if (k === 'inkWidth' && a.type === 'ink') a.width = v;
          if (k === 'inkOpacity' && a.type === 'ink') a.opacity = v;
          if (k === 'shapeWidth' && (a.type === 'rect' || a.type === 'ellipse' || a.type === 'line')) a.width = v;
          if (k === 'fill' && (a.type === 'rect' || a.type === 'ellipse')) a.fill = v ? fillOf(a.color) : null;
          if (k === 'fieldKind' && a.type === 'field') a.kind = v;
        }
      }
    });
  }

  /** Edits arbitrary properties of the selected annotations as one undo step. */
  updateSelection(fn: (a: Annot) => void) {
    const sel = this.selection;
    if (sel.length) this.model.edit('annots', () => sel.forEach(fn));
  }

  deleteSelection() {
    const ids = this.viewer.selected;
    if (!ids.size) return false;
    this.model.edit('annots', () => {
      for (const p of this.model.pages) p.annots = p.annots.filter((a) => !ids.has(a.id));
    });
    this.select([]);
    return true;
  }

  nudge(dx: number, dy: number) {
    const sel = this.selection;
    if (!sel.length) return false;
    const found = this.model.findAnnot(sel[0].id)!;
    const v = this.viewer.viewOfKey(found.page.key)!;
    // Arrow keys move in screen directions, so map through the (possibly rotated) page transform.
    const a = v.toPdf(0, 0);
    const b = v.toPdf(dx, dy);
    this.model.edit('annots', () => sel.forEach((s) => translate(s, b[0] - a[0], b[1] - a[1])));
    return true;
  }

  copy() {
    const sel = this.selection;
    if (!sel.length) return false;
    this.clipboard = { annots: clone(sel) };
    return true;
  }

  get hasClipboard() {
    return !!this.clipboard;
  }

  paste() {
    if (!this.clipboard) return false;
    const page = this.model.pages[this.viewer.currentIndex];
    if (!page) return false;
    const copies = clone(this.clipboard.annots).map((a) => {
      a.id = newId();
      delete a.replies;
      translate(a, 12, -12);
      return a;
    });
    this.clipboard.annots = clone(copies);
    this.model.edit('annots', () => this.model.addAnnots(page, ...copies));
    this.select(copies.map((a) => a.id));
    return true;
  }

  startPlacing(p: Placing) {
    this.setTool('place');
    this.placing = p;
  }

  /** Lets the user drag a rectangle on a page; resolves to null if cancelled. */
  pickRect(): Promise<{ view: PageView; box: Box } | null> {
    this.setTool('pickrect');
    return new Promise((resolve) => (this.rectPick = resolve));
  }

  // ---------------------------------------------------------------- snapping

  private snapTargets(view: PageView, exclude: Set<string>) {
    const { width, height } = view.geom;
    const xs = [0, width / 2, width];
    const ys = [0, height / 2, height];
    for (const a of view.page.annots) {
      if (exclude.has(a.id)) continue;
      const r = this.screenBox(view, bbox(a));
      xs.push(r.x, r.x + r.w / 2, r.x + r.w);
      ys.push(r.y, r.y + r.h / 2, r.y + r.h);
    }
    return { xs, ys };
  }

  private screenBox(view: PageView, b: Box): Box {
    const p1 = view.toScreen(b.x, b.y);
    const p2 = view.toScreen(b.x + b.w, b.y + b.h);
    return boxFromPts(p1, p2);
  }

  private snap1(values: number[], targets: number[], grid: number | null): SnapResult {
    const all = [...targets];
    if (grid) for (const v of values) all.push(Math.round(v / grid) * grid);
    let best: SnapResult = { delta: 0, at: null };
    let bestDist = 6;
    for (const v of values)
      for (const t of all) {
        const d = Math.abs(t - v);
        if (d < bestDist) {
          bestDist = d;
          best = { delta: t - v, at: t };
        }
      }
    return best;
  }

  private gridStep(view: PageView) {
    return settings.grid ? settings.gridSize * UNIT_PT[settings.units] * view.scale : null;
  }

  /** Snaps a client point to page edges, other annotations and the grid. Returns client coords. */
  private snapPoint(view: PageView, clientX: number, clientY: number, ev: PointerEvent, exclude = new Set<string>()): Pt {
    if (!settings.snap || ev.altKey) return [clientX, clientY];
    const r = view.el.getBoundingClientRect();
    const t = this.snapTargets(view, exclude);
    const g = this.gridStep(view);
    const sx = this.snap1([clientX - r.left], t.xs, g);
    const sy = this.snap1([clientY - r.top], t.ys, g);
    this.showGuides(view, sx.at, sy.at);
    return [clientX + sx.delta, clientY + sy.delta];
  }

  private showGuides(view: PageView, x: number | null, y: number | null) {
    view.selG.querySelectorAll('.guide').forEach((e) => e.remove());
    const { width, height } = view.geom;
    if (x !== null) view.selG.append(svgEl('line', { class: 'guide', x1: x, y1: 0, x2: x, y2: height }));
    if (y !== null) view.selG.append(svgEl('line', { class: 'guide', x1: 0, y1: y, x2: width, y2: y }));
  }

  // ---------------------------------------------------------------- pointer handling

  private onPointerDown(e: PointerEvent) {
    if (e.button === 1 || (e.button === 0 && this.tool === 'hand')) return this.pan(e);
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('.inline-editor, .note-editor')) return;
    this.editor?.close(true);
    const view = this.viewer.viewAt(e.clientX, e.clientY);

    if (this.tool === 'select') {
      const handle = target.closest('[data-handle]') as SVGElement | null;
      if (handle && view) return this.resize(e, view, handle.dataset.handle!);
      const el = target.closest('[data-id]') as SVGElement | null;
      if (el && view) {
        const id = el.dataset.id!;
        if (e.shiftKey || e.ctrlKey) {
          const ids = new Set(this.viewer.selected);
          if (ids.has(id)) ids.delete(id);
          else ids.add(id);
          this.select([...ids]);
          return;
        }
        if (!this.viewer.selected.has(id)) this.select([id]);
        return this.move(e, view);
      }
      if (!target.closest('.annotationLayer')) this.select([]);
      return;
    }
    if (!view) return;
    const p = view.toPdf(e.clientX, e.clientY);
    switch (this.tool) {
      case 'text': {
        const hit = target.closest('.annot-text') as SVGElement | null;
        const existing = hit && view.page.annots.find((a) => a.id === hit.dataset.id);
        e.preventDefault();
        if (existing && existing.type === 'text') this.editText(view, existing, false);
        else this.createText(view, e);
        return;
      }
      case 'edittext': {
        const span = target.closest('.textLayer span') as HTMLElement | null;
        if (!span) return;
        e.preventDefault();
        this.editPageText(view, span);
        return;
      }
      case 'note': {
        e.preventDefault();
        const note: NoteAnnot = { id: newId(), type: 'note', x: p[0], y: p[1], text: '', rot: view.page.rotation, color: this.style.noteColor };
        this.model.edit('annots', () => this.model.addAnnots(view.page, note));
        this.editNote(view, note, true);
        return;
      }
      case 'draw':
        return this.draw(e, view);
      case 'highlight':
      case 'underline':
      case 'strike':
      case 'redact':
        // Starting on a text span selects text; starting elsewhere draws an area (useful for scans).
        if (target.closest('.textLayer span')) return;
        return this.dragBox(e, view);
      case 'rect':
      case 'ellipse':
      case 'whiteout':
      case 'field':
      case 'pickrect':
        return this.dragBox(e, view);
      case 'line':
      case 'arrow':
      case 'measure':
        return this.dragLine(e, view);
      case 'place':
        e.preventDefault();
        return this.placeAt(view, p);
    }
  }

  private track(e: PointerEvent, onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent) => void) {
    const el = e.target as Element;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      for (const v of this.viewer.order) v.selG.querySelectorAll('.guide').forEach((g) => g.remove());
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  private pan(e: PointerEvent) {
    e.preventDefault();
    const c = this.viewer.container;
    const sx = e.clientX,
      sy = e.clientY,
      sl = c.scrollLeft,
      st = c.scrollTop;
    c.classList.add('panning');
    this.track(
      e,
      (ev) => {
        c.scrollLeft = sl - (ev.clientX - sx);
        c.scrollTop = st - (ev.clientY - sy);
      },
      () => c.classList.remove('panning'),
    );
  }

  private move(e: PointerEvent, view: PageView) {
    e.preventDefault();
    const ids = new Set(this.viewer.selected);
    const annots = view.page.annots.filter((a) => ids.has(a.id));
    const origs = annots.map(clone);
    const box = this.screenBox(view, unionAll(origs.map(bbox)));
    const targets = this.snapTargets(view, ids);
    const start = view.toPdf(e.clientX, e.clientY);
    let moved = false;
    this.track(
      e,
      (ev) => {
        if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        if (!moved) {
          this.model.checkpoint();
          moved = true;
        }
        let dxs = ev.clientX - e.clientX,
          dys = ev.clientY - e.clientY;
        let gx: number | null = null,
          gy: number | null = null;
        if (settings.snap && !ev.altKey) {
          const g = this.gridStep(view);
          const sx = this.snap1([box.x + dxs, box.x + box.w / 2 + dxs, box.x + box.w + dxs], targets.xs, g);
          const sy = this.snap1([box.y + dys, box.y + box.h / 2 + dys, box.y + box.h + dys], targets.ys, g);
          dxs += sx.delta;
          dys += sy.delta;
          gx = sx.at;
          gy = sy.at;
        }
        const p = view.toPdf(e.clientX + dxs, e.clientY + dys);
        annots.forEach((a, i) => {
          Object.assign(a, clone(origs[i]));
          translate(a, p[0] - start[0], p[1] - start[1]);
        });
        this.viewer.drawOverlays(view);
        this.showGuides(view, gx, gy);
      },
      () => {
        if (moved) this.model.emit('annots');
      },
    );
  }

  private resize(e: PointerEvent, view: PageView, id: string) {
    e.preventDefault();
    e.stopPropagation();
    const a = view.page.annots.find((x) => x.id === id);
    if (!a) return;
    const orig = clone(a);
    const ob = bbox(orig);
    const s1 = view.toScreen(ob.x, ob.y);
    const s2 = view.toScreen(ob.x + ob.w, ob.y + ob.h);
    const r = view.el.getBoundingClientRect();
    const fixed = view.toPdf(r.left + Math.min(s1[0], s2[0]), r.top + Math.min(s1[1], s2[1]));
    const lockAspect = a.type === 'image' || a.type === 'stamp';
    let changed = false;
    this.track(
      e,
      (ev) => {
        if (!changed) {
          this.model.checkpoint();
          changed = true;
        }
        const [cx, cy] = this.snapPoint(view, ev.clientX, ev.clientY, ev, new Set([id]));
        const p = view.toPdf(cx, cy);
        let dx = p[0] - fixed[0];
        let dy = p[1] - fixed[1];
        if (lockAspect !== ev.shiftKey && ob.w && ob.h) {
          const s = Math.max(Math.abs(dx) / ob.w, Math.abs(dy) / ob.h);
          dx = Math.sign(dx || 1) * ob.w * s;
          dy = Math.sign(dy || 1) * ob.h * s;
        }
        const nb = boxFromPts(fixed, [fixed[0] + dx, fixed[1] + dy]);
        if (nb.w < 2 || nb.h < 2) return;
        const fresh = clone(orig);
        setBox(fresh, ob, nb);
        Object.assign(a, fresh);
        this.viewer.drawOverlays(view);
      },
      () => {
        if (changed) this.model.emit('annots');
      },
    );
  }

  private draw(e: PointerEvent, view: PageView) {
    e.preventDefault();
    const pts: number[] = [...view.toPdf(e.clientX, e.clientY)];
    const st = this.style;
    const path = svgEl('path', {
      fill: 'none',
      stroke: st.inkColor,
      'stroke-width': st.inkWidth,
      'stroke-opacity': st.inkOpacity,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    view.draftG.append(path);
    const minDist = 0.75 / view.scale;
    const redraw = () => path.setAttribute('d', `M${pts.slice(0, 2).join(' ')}` + pts.slice(2).map((n, i) => (i % 2 ? ` ${n}` : ` L${n}`)).join(''));
    redraw();
    this.track(
      e,
      (ev) => {
        const events = ev.getCoalescedEvents?.() ?? [ev];
        for (const ce of events.length ? events : [ev]) {
          const p = view.toPdf(ce.clientX, ce.clientY);
          const n = pts.length;
          if (Math.hypot(p[0] - pts[n - 2], p[1] - pts[n - 1]) < minDist) continue;
          pts.push(+p[0].toFixed(2), +p[1].toFixed(2));
        }
        redraw();
      },
      () => {
        path.remove();
        // Strokes drawn in quick succession form one drawing, like handwriting in Acrobat.
        const prev = this.lastInk && Date.now() - this.lastInk.at < 1500 ? (view.page.annots.find((a) => a.id === this.lastInk!.id) as InkAnnot | undefined) : undefined;
        if (prev && prev.color === st.inkColor && prev.width === st.inkWidth && prev.opacity === st.inkOpacity) {
          this.model.edit('annots', () => prev.strokes.push(pts));
          this.lastInk = { id: prev.id, at: Date.now() };
          return;
        }
        const a: InkAnnot = { id: newId(), type: 'ink', strokes: [pts], color: st.inkColor, width: st.inkWidth, opacity: st.inkOpacity };
        this.model.edit('annots', () => this.model.addAnnots(view.page, a));
        this.lastInk = { id: a.id, at: Date.now() };
      },
    );
  }

  private dragBox(e: PointerEvent, view: PageView) {
    e.preventDefault();
    const tool = this.tool;
    const [sx, sy] = this.snapPoint(view, e.clientX, e.clientY, e);
    const start = view.toPdf(sx, sy);
    const draft = svgEl(tool === 'ellipse' ? 'ellipse' : 'rect', { class: `draft draft-${tool}` });
    const color = tool === 'whiteout' ? '#ffffff' : tool === 'redact' ? '#e11d48' : tool === 'field' || tool === 'pickrect' ? '#2563eb' : (this.style[colorKey(tool) as 'shapeColor'] as string);
    draft.setAttribute('stroke', tool === 'whiteout' ? '#888' : color);
    draft.setAttribute('fill', tool === 'whiteout' ? '#fff' : MARKUP_TOOLS.includes(tool) || tool === 'field' || tool === 'pickrect' ? color : 'none');
    draft.setAttribute('stroke-width', String(this.style.shapeWidth));
    view.draftG.append(draft);
    let box: Box = { x: start[0], y: start[1], w: 0, h: 0 };
    this.track(
      e,
      (ev) => {
        const [cx, cy] = this.snapPoint(view, ev.clientX, ev.clientY, ev);
        box = boxFromPts(start, view.toPdf(cx, cy));
        if (tool === 'ellipse') {
          draft.setAttribute('cx', String(box.x + box.w / 2));
          draft.setAttribute('cy', String(box.y + box.h / 2));
          draft.setAttribute('rx', String(box.w / 2));
          draft.setAttribute('ry', String(box.h / 2));
        } else {
          draft.setAttribute('x', String(box.x));
          draft.setAttribute('y', String(box.y));
          draft.setAttribute('width', String(box.w));
          draft.setAttribute('height', String(box.h));
        }
      },
      () => {
        draft.remove();
        if (box.w * view.scale < 3 || box.h * view.scale < 3) return;
        if (tool === 'pickrect') {
          const done = this.rectPick;
          this.rectPick = null;
          this.setTool('select');
          done?.({ view, box });
          return;
        }
        let a: Annot;
        if (tool === 'whiteout') a = { id: newId(), type: 'whiteout', ...box, color: '#ffffff' };
        else if (tool === 'redact') a = { id: newId(), type: 'redact', rects: [box], color: '#000000' };
        else if (tool === 'field') a = this.newField(view, box);
        else if (tool === 'rect' || tool === 'ellipse')
          a = { id: newId(), type: tool, ...box, color, width: this.style.shapeWidth, fill: this.style.fill ? fillOf(color) : null };
        else a = { id: newId(), type: 'markup', kind: tool as MarkupKind, rects: [box], color };
        this.model.edit('annots', () => this.model.addAnnots(view.page, a));
        if (tool === 'field') {
          this.setTool('select');
          this.select([a.id]);
        }
      },
    );
  }

  private newField(view: PageView, box: Box): Annot {
    const kind = this.style.fieldKind;
    const prefix = { text: 'Text', multiline: 'Text', checkbox: 'Check', radio: 'Choice', dropdown: 'Dropdown' }[kind];
    const names = new Set(this.model.pages.flatMap((p) => p.annots.flatMap((a) => (a.type === 'field' ? [a.name] : []))));
    let n = 1;
    while (names.has(`${prefix}${n}`)) n++;
    const options = kind === 'dropdown' ? ['Option 1', 'Option 2'] : kind === 'radio' ? ['Choice 1'] : [];
    return { id: newId(), type: 'field', kind, name: `${prefix}${n}`, options, fontSize: 11, rot: view.page.rotation, color: '#2563eb', ...box };
  }

  private dragLine(e: PointerEvent, view: PageView) {
    e.preventDefault();
    const tool = this.tool;
    const [sx, sy] = this.snapPoint(view, e.clientX, e.clientY, e);
    const start = view.toPdf(sx, sy);
    const line = svgEl('line', {
      stroke: this.style.shapeColor,
      'stroke-width': this.style.shapeWidth,
      'stroke-linecap': 'round',
      x1: start[0],
      y1: start[1],
      x2: start[0],
      y2: start[1],
    });
    view.draftG.append(line);
    const label = svgEl('text', { class: 'measure-live' });
    if (tool === 'measure') view.selG.append(label);
    let end: Pt = start;
    this.track(
      e,
      (ev) => {
        let [cx, cy] = this.snapPoint(view, ev.clientX, ev.clientY, ev);
        if (ev.shiftKey) {
          // Snap to 45° in screen space.
          const dx = cx - sx,
            dy = cy - sy;
          const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(dx, dy);
          cx = sx + Math.cos(ang) * len;
          cy = sy + Math.sin(ang) * len;
        }
        end = view.toPdf(cx, cy);
        line.setAttribute('x2', String(end[0]));
        line.setAttribute('y2', String(end[1]));
        if (tool === 'measure') {
          const r = view.el.getBoundingClientRect();
          label.setAttribute('x', String(cx - r.left + 10));
          label.setAttribute('y', String(cy - r.top - 10));
          const len = Math.hypot(end[0] - start[0], end[1] - start[1]) / UNIT_PT[settings.units];
          label.textContent = `${len.toFixed(settings.units === 'mm' ? 1 : 2)} ${settings.units}`;
        }
      },
      () => {
        line.remove();
        label.remove();
        if (Math.hypot(end[0] - start[0], end[1] - start[1]) * view.scale < 4) return;
        this.model.edit('annots', () =>
          this.model.addAnnots(view.page, {
            id: newId(),
            type: 'line',
            x1: start[0],
            y1: start[1],
            x2: end[0],
            y2: end[1],
            color: this.style.shapeColor,
            width: tool === 'measure' ? 1 : this.style.shapeWidth,
            arrow: tool === 'arrow',
            measure: tool === 'measure',
          }),
        );
      },
    );
  }

  placeAt(view: PageView, p: Pt) {
    const pl = this.placing;
    if (!pl) return;
    const rot = view.page.rotation;
    const [vx0, vy0, vx1, vy1] = view.page.view;
    let a: ImageAnnot | StampAnnot;
    if (pl.kind === 'image') {
      // Size against the page as displayed, then swap axes for rotated pages since the box lives in PDF space.
      const dispW = rot % 180 ? vy1 - vy0 : vx1 - vx0;
      let w = Math.min(pl.w * 0.75, dispW * 0.4);
      let hh = (w * pl.h) / pl.w;
      if (rot % 180) [w, hh] = [hh, w];
      a = { id: newId(), type: 'image', x: p[0] - w / 2, y: p[1] - hh / 2, w, h: hh, img: pl.img, rot, color: '#000000' };
    } else {
      let { w, h: hh } = stampSize(pl.label, pl.sub);
      if (rot % 180) [w, hh] = [hh, w];
      a = { id: newId(), type: 'stamp', x: p[0] - w / 2, y: p[1] - hh / 2, w, h: hh, label: pl.label, sub: pl.sub, rot, color: pl.color };
    }
    this.model.edit('annots', () => this.model.addAnnots(view.page, a));
    this.setTool('select');
    this.select([a.id]);
  }

  private onDblClick(e: MouseEvent) {
    if (this.tool !== 'select') return;
    const el = (e.target as Element).closest('[data-id]') as SVGElement | null;
    const view = this.viewer.viewAt(e.clientX, e.clientY);
    if (!el || !view) return;
    const a = view.page.annots.find((x) => x.id === el.dataset.id);
    if (a?.type === 'text') this.editText(view, a, false);
    if (a?.type === 'note') this.editNote(view, a, false);
    if (a && a.type !== 'text' && a.type !== 'note') this.dispatchEvent(new CustomEvent('comment', { detail: a.id }));
  }

  // ---------------------------------------------------------------- text & notes

  /** The text item of the original page under a PDF point, if any. */
  private async textItemAt(view: PageView, p: Pt) {
    const pt = await this.index.get(view.page.src, view.page.index);
    if (!pt) return null;
    for (const it of pt.content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a < 0) continue;
      const size = Math.hypot(c, d);
      if (p[0] >= e && p[0] <= e + it.width && p[1] >= f - size * 0.3 && p[1] <= f + size * 0.95) return { item: it as TextItem, size, styles: pt.content.styles };
    }
    return null;
  }

  private async createText(view: PageView, e: PointerEvent) {
    const p = view.toPdf(e.clientX, e.clientY);
    const match = view.page.rotation === 0 ? await this.textItemAt(view, p) : null;
    // Clicking on existing text adopts its size and family, so additions blend in.
    const size = match ? Math.round(match.size * 2) / 2 : this.style.fontSize;
    const font = match ? familyOf(match.styles[match.item.fontName]?.fontFamily) : this.style.font;
    const fs = size * view.scale;
    const anchor = match ? ([p[0], match.item.transform[5]] as Pt) : view.toPdf(e.clientX - 2, e.clientY + 0.35 * fs);
    const a: TextAnnot = { id: newId(), type: 'text', x: anchor[0], y: anchor[1], text: '', size, font, rot: view.page.rotation, color: this.style.textColor };
    this.editText(view, a, true);
  }

  private async editPageText(view: PageView, span: HTMLElement) {
    const divs = view.textLayer?.textDivs ?? [];
    const idx = divs.indexOf(span);
    const pt = await this.index.get(view.page.src, view.page.index);
    if (idx < 0 || !pt) return;
    const item = pt.content.items.filter((i): i is TextItem => 'str' in i)[idx];
    if (!item?.str.trim()) return;
    const [a, b, c, d, e, f] = item.transform;
    if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a < 0) {
      toast('Rotated text cannot be edited', 'error');
      return;
    }
    const size = Math.hypot(c, d);
    const cover: Box = { x: e - 0.5, y: f - size * 0.26, w: item.width + 1, h: size * 1.18 };
    const { bg, fg } = sampleColors(view, cover);
    const annot: TextAnnot = {
      id: newId(),
      type: 'text',
      x: e,
      y: f,
      text: item.str,
      size: Math.round(size * 10) / 10,
      font: familyOf(pt.content.styles[item.fontName]?.fontFamily),
      rot: 0,
      color: fg,
      bg: { ...cover, color: bg },
    };
    this.editText(view, annot, true, item.str);
  }

  editText(view: PageView, a: TextAnnot, isNew: boolean, original?: string) {
    this.editor?.close(true);
    const scale = view.scale;
    const fs = a.size * scale;
    const [sx, sy] = view.toScreen(a.x, a.y);
    const ta = h('textarea', { class: 'inline-editor', value: a.text, spellcheck: true });
    Object.assign(ta.style, {
      left: `${sx}px`,
      top: `${sy - 0.945 * fs}px`,
      fontSize: `${fs}px`,
      lineHeight: String(LINE_HEIGHT),
      fontFamily: FONT_CSS[a.font],
      color: a.color,
      background: a.bg ? a.bg.color : '',
    });
    let cover: SVGRectElement | null = null;
    if (a.bg) {
      cover = svgEl('rect', { x: a.bg.x, y: a.bg.y, width: a.bg.w, height: a.bg.h, fill: a.bg.color });
      view.draftG.append(cover);
    }
    const fit = () => {
      const lines = ta.value.split('\n');
      const w = Math.max(...lines.map((l) => textWidth(l, a.font, a.size))) * scale;
      ta.style.width = `${Math.max(fs * 2, w + fs)}px`;
      ta.style.height = `${lines.length * fs * LINE_HEIGHT + 2}px`;
    };
    fit();
    ta.addEventListener('input', fit);
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && ev.ctrlKey)) {
        ev.preventDefault();
        close(true);
      }
    });
    view.hiddenAnnot = a.id;
    this.viewer.drawOverlays(view);
    view.el.append(ta);
    let closed = false;
    const close = (commit: boolean) => {
      if (closed) return;
      closed = true;
      this.editor = null;
      ta.remove();
      cover?.remove();
      view.hiddenAnnot = null;
      const text = ta.value.replace(/\s+$/, '');
      const unchanged = original !== undefined ? text === original : text === a.text;
      if (commit && !unchanged) {
        this.model.edit('annots', () => {
          if (isNew) {
            if (text || a.bg) this.model.addAnnots(view.page, { ...a, text });
          } else if (!text && !a.bg) view.page.annots = view.page.annots.filter((x) => x.id !== a.id);
          else a.text = text;
        });
      } else this.viewer.drawOverlays(view);
      if (commit && !isNew && text) this.select([a.id]);
    };
    ta.addEventListener('blur', () => close(true));
    this.editor = { close };
    ta.focus();
    if (!isNew || original !== undefined) ta.select();
  }

  editNote(view: PageView, a: NoteAnnot, isNew: boolean) {
    this.editor?.close(true);
    const [sx, sy] = view.toScreen(a.x, a.y);
    const ta = h('textarea', { value: a.text, placeholder: 'Add a comment…', rows: 5 });
    const del = h('button', { textContent: 'Delete', class: 'danger' });
    const done = h('button', { textContent: 'Done', class: 'primary' });
    const box = h('div', { class: 'note-editor' }, ta, h('div', { class: 'note-actions' }, del, done));
    box.style.left = `${sx + 24}px`;
    box.style.top = `${sy}px`;
    view.el.append(box);
    let closed = false;
    const close = (commit: boolean, remove = false) => {
      if (closed) return;
      closed = true;
      this.editor = null;
      box.remove();
      const text = ta.value.trim();
      if (remove || (commit && !text && isNew)) {
        // An empty new note is discarded; undoing its creation keeps history clean.
        if (isNew && !remove) {
          this.model.undo();
          this.model.discardRedo();
        } else this.model.edit('annots', () => (view.page.annots = view.page.annots.filter((x) => x.id !== a.id)));
        return;
      }
      if (commit && text !== a.text) this.model.edit('annots', () => (a.text = text));
    };
    del.onclick = () => close(false, true);
    done.onclick = () => close(true);
    box.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && ev.ctrlKey)) close(true);
    });
    box.addEventListener('focusout', (ev) => {
      if (!box.contains(ev.relatedTarget as Node)) close(true);
    });
    this.editor = { close };
    ta.focus();
  }

  // ---------------------------------------------------------------- text selection → markup

  private onSelectionDone() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchorEl = (range.commonAncestorContainer as Element).parentElement ?? (range.commonAncestorContainer as Element);
    if (!anchorEl?.closest?.('.pdfViewer')) return;
    if (MARKUP_TOOLS.includes(this.tool)) {
      this.markupFromSelection(this.tool as MarkupKind | 'redact');
      return;
    }
    if (this.tool !== 'select') return;
    const last = [...range.getClientRects()].pop();
    if (!last) return;
    const btn = (label: string, fn: () => void) =>
      h('button', { textContent: label, onpointerdown: (ev: Event) => ev.preventDefault(), onclick: fn });
    this.markBar.replaceChildren(
      btn('Highlight', () => this.markupFromSelection('highlight')),
      btn('Underline', () => this.markupFromSelection('underline')),
      btn('Strikethrough', () => this.markupFromSelection('strike')),
      btn('Redact', () => this.markupFromSelection('redact')),
      btn('Copy', () => {
        navigator.clipboard.writeText(sel.toString());
        this.markBar.classList.remove('show');
      }),
    );
    this.markBar.style.left = `${Math.min(last.right, innerWidth - 300)}px`;
    this.markBar.style.top = `${last.bottom + 6}px`;
    this.markBar.classList.add('show');
  }

  markupFromSelection(kind: MarkupKind | 'redact') {
    const sel = document.getSelection();
    this.markBar.classList.remove('show');
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
    const rects = textRects(sel.getRangeAt(0)).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) return;
    const heights = rects.map((r) => r.height).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const byView = new Map<PageView, DOMRect[]>();
    for (const r of rects) {
      // Element boxes (endOfContent, whole layers) show up in range rects; drop the oversized ones.
      if (r.height > median * 2.5) continue;
      const v = this.viewer.viewAt(r.left + r.width / 2, r.top + r.height / 2);
      if (!v) continue;
      const list = byView.get(v) ?? [];
      list.push(r);
      byView.set(v, list);
    }
    const additions: [PageView, Annot][] = [];
    for (const [v, list] of byView) {
      const boxes = mergeLineRects(list).map((r) => boxFromPts(v.toPdf(r.left, r.top), v.toPdf(r.right, r.bottom)));
      const a: Annot =
        kind === 'redact'
          ? { id: newId(), type: 'redact', rects: boxes, color: '#000000' }
          : { id: newId(), type: 'markup', kind, rects: boxes, color: this.style.markColor, quote };
      additions.push([v, a]);
    }
    if (!additions.length) return;
    this.model.edit('annots', () => additions.forEach(([v, a]) => this.model.addAnnots(v.page, a)));
    sel.removeAllRanges();
  }
}

/**
 * Client rects of the selected glyphs only. Range.getClientRects() also returns element boxes and
 * end-of-line boxes that stretch to the layer edge, which would make markups too wide.
 */
function textRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  const container = root.nodeType === Node.TEXT_NODE ? root.parentNode! : root;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const out: DOMRect[] = [];
  for (let n = walker.currentNode.nodeType === Node.TEXT_NODE ? walker.currentNode : walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n) || !(n.parentElement?.closest('.textLayer'))) continue;
    const r = document.createRange();
    r.selectNodeContents(n);
    if (n === range.startContainer) r.setStart(n, range.startOffset);
    if (n === range.endContainer) r.setEnd(n, range.endOffset);
    out.push(...r.getClientRects());
  }
  return out;
}

function unionAll(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x)),
    y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)),
    y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function familyOf(cssFamily?: string): FontName {
  if (!cssFamily) return 'Helvetica';
  if (/mono/i.test(cssFamily)) return 'Courier';
  if (/serif/i.test(cssFamily) && !/sans/i.test(cssFamily)) return 'Times';
  return 'Helvetica';
}

/** Picks the background (most common edge colour) and text colour (most different pixel) in a box. */
function sampleColors(view: PageView, box: Box): { bg: string; fg: string } {
  const canvas = view.canvas;
  const fallback = { bg: '#ffffff', fg: '#000000' };
  if (!canvas) return fallback;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return fallback;
  const k = canvas.width / view.geom.width;
  const p1 = view.toScreen(box.x, box.y);
  const p2 = view.toScreen(box.x + box.w, box.y + box.h);
  const x = Math.max(0, Math.floor(Math.min(p1[0], p2[0]) * k));
  const y = Math.max(0, Math.floor(Math.min(p1[1], p2[1]) * k));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(Math.abs(p2[0] - p1[0]) * k)));
  const hh = Math.max(1, Math.min(canvas.height - y, Math.ceil(Math.abs(p2[1] - p1[1]) * k)));
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x, y, w, hh).data;
  } catch {
    return fallback;
  }
  const px = (i: number, j: number) => {
    const o = (Math.min(hh - 1, j) * w + Math.min(w - 1, i)) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const counts = new Map<string, { n: number; c: number[] }>();
  for (let i = 0; i < w; i += Math.max(1, Math.floor(w / 24)))
    for (const j of [0, hh - 1]) {
      const c = px(i, j);
      const key = c.map((v) => v >> 4).join(',');
      const e = counts.get(key) ?? { n: 0, c };
      e.n++;
      counts.set(key, e);
    }
  const bg = [...counts.values()].sort((a, b) => b.n - a.n)[0]?.c ?? [255, 255, 255];
  let fg = [0, 0, 0];
  let best = -1;
  for (let j = 0; j < hh; j += Math.max(1, Math.floor(hh / 12)))
    for (let i = 0; i < w; i += Math.max(1, Math.floor(w / 60))) {
      const c = px(i, j);
      const dist = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (dist > best) {
        best = dist;
        fg = c;
      }
    }
  const hex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  return { bg: hex(bg), fg: best > 60 ? hex(fg) : '#000000' };
}

function mergeLineRects(rects: DOMRect[]) {
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const r of sorted) {
    const cy = (r.top + r.bottom) / 2;
    const line = out.find((o) => cy > o.top && cy < o.bottom && r.left <= o.right + r.height * 0.6 && r.right >= o.left - r.height * 0.6);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else out.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
  }
  return out;
}

export function fillOf(color: string) {
  return color.slice(0, 7) + '33';
}
