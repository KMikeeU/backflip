import { LayoutGrid, Bookmark, MessageSquare } from 'lucide';
import { annotSvg, textWidth } from './annots';
import { CommentsPanel, type CommentsActions } from './comments';
import { decorations, decorSvg } from './decor';
import { OutlinePanel, type OutlineActions } from './outline';
import { matStr, pageGeom } from './geom';
import type { DocModel, PageItem } from './model';
import { h, icon } from './ui';
import type { Viewer } from './viewer';

const THUMB = 132;
const SVGNS = 'http://www.w3.org/2000/svg';

class Thumb {
  el: HTMLDivElement;
  box: HTMLDivElement;
  label: HTMLSpanElement;
  svg: SVGSVGElement;
  g: SVGGElement;
  canvas: HTMLCanvasElement | null = null;
  renderedRotation: number | null = null;
  rendering = false;

  constructor(public page: PageItem) {
    this.box = h('div', { class: 'thumb-page' });
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.g = document.createElementNS(SVGNS, 'g');
    this.svg.append(this.g);
    this.box.append(this.svg);
    this.label = h('span', { class: 'thumb-label' });
    this.el = h('div', { class: 'thumb', draggable: true, dataset: { key: page.key } }, this.box, this.label);
  }

  get scale() {
    const v = this.page.view;
    return THUMB / Math.max(v[2] - v[0], v[3] - v[1]);
  }

  layout() {
    const g = pageGeom(this.page.view, this.scale, this.page.rotation);
    this.box.style.width = `${Math.round(g.width)}px`;
    this.box.style.height = `${Math.round(g.height)}px`;
    this.svg.setAttribute('width', String(g.width));
    this.svg.setAttribute('height', String(g.height));
    this.g.setAttribute('transform', matStr(g.transform));
  }

  async render(model: DocModel) {
    if (this.rendering || this.renderedRotation === this.page.rotation) return;
    this.rendering = true;
    const rotation = this.page.rotation;
    try {
      if (this.page.src >= 0) {
        const proxy = await model.sources[this.page.src].doc.getPage(this.page.index + 1);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const vp = proxy.getViewport({ scale: this.scale * dpr, rotation });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        await proxy.render({ canvas: c, viewport: vp }).promise;
        if (this.canvas) this.canvas.replaceWith(c);
        else this.box.prepend(c);
        this.canvas = c;
      }
      this.renderedRotation = rotation;
    } catch (e) {
      console.warn('thumbnail failed', e);
    } finally {
      this.rendering = false;
    }
    if (this.renderedRotation !== this.page.rotation) this.render(model);
  }
}

export type SidebarTab = 'pages' | 'bookmarks' | 'comments';

export interface SidebarActions extends OutlineActions, CommentsActions {
  insertFiles(files: File[], at: number): void;
  pageMenu(keys: string[], x: number, y: number): void;
  movePages(keys: string[], to: number): void;
}

export class Sidebar {
  readonly el: HTMLElement;
  private list: HTMLDivElement;
  readonly outline: OutlinePanel;
  readonly comments: CommentsPanel;
  tab: SidebarTab = 'pages';
  private tabs = new Map<SidebarTab, HTMLButtonElement>();
  private thumbs = new Map<string, Thumb>();
  private io: IntersectionObserver;
  selectedKeys = new Set<string>();
  private anchorKey: string | null = null;
  private dropIndicator = h('div', { class: 'drop-indicator' });
  private dragKeys: string[] | null = null;

  constructor(
    private model: DocModel,
    private viewer: Viewer,
    private actions: SidebarActions,
  ) {
    this.list = h('div', { class: 'thumbs panel' });
    this.outline = new OutlinePanel(model, actions);
    this.comments = new CommentsPanel(model, actions);
    const tabBar = h('div', { class: 'tabs' });
    for (const [id, ic, label] of [
      ['pages', LayoutGrid, 'Pages'],
      ['bookmarks', Bookmark, 'Bookmarks'],
      ['comments', MessageSquare, 'Comments'],
    ] as const) {
      const b = h('button', { class: 'tab', title: label, onclick: () => this.showTab(id) }, icon(ic, 16), h('span', { textContent: label }));
      this.tabs.set(id, b);
      tabBar.append(b);
    }
    this.el = h('aside', { class: 'sidebar' }, tabBar, this.list, this.outline.el, this.comments.el);
    this.showTab('pages');

    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = this.thumbs.get((e.target as HTMLElement).dataset.key!);
          t?.render(this.model);
        }
      },
      { root: this.list, rootMargin: '300px 0px' },
    );
    this.bindEvents();
  }

  private bindEvents() {
    const keyOf = (e: Event) => ((e.target as Element).closest('.thumb') as HTMLElement | null)?.dataset.key;
    this.list.addEventListener('click', (e) => {
      const key = keyOf(e);
      if (!key) return;
      const keys = this.model.pages.map((p) => p.key);
      if (e.shiftKey && this.anchorKey) {
        const [a, b] = [keys.indexOf(this.anchorKey), keys.indexOf(key)].sort((x, y) => x - y);
        this.selectedKeys = new Set(keys.slice(a, b + 1));
      } else if (e.ctrlKey || e.metaKey) {
        if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
        else this.selectedKeys.add(key);
        this.anchorKey = key;
      } else {
        this.selectedKeys = new Set([key]);
        this.anchorKey = key;
        this.viewer.scrollToPage(keys.indexOf(key));
      }
      this.paintSelection();
    });
    this.list.addEventListener('contextmenu', (e) => {
      const key = keyOf(e);
      if (!key) return;
      e.preventDefault();
      if (!this.selectedKeys.has(key)) {
        this.selectedKeys = new Set([key]);
        this.anchorKey = key;
        this.paintSelection();
      }
      this.actions.pageMenu(this.orderedSelection(), e.clientX, e.clientY);
    });
    this.list.addEventListener('dragstart', (e) => {
      const key = keyOf(e);
      if (!key) return;
      this.dragKeys = this.selectedKeys.has(key) ? this.orderedSelection() : [key];
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('application/x-pdf-pages', this.dragKeys.join(','));
    });
    this.list.addEventListener('dragend', () => {
      this.dragKeys = null;
      this.dropIndicator.remove();
    });
    this.list.addEventListener('dragover', (e) => {
      const files = e.dataTransfer?.types.includes('Files');
      if (!this.dragKeys && !files) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = files ? 'copy' : 'move';
      const at = this.dropIndex(e.clientY);
      const thumbsOnly = [...this.list.querySelectorAll('.thumb')];
      const target = thumbsOnly[at] ?? null;
      if (target) this.list.insertBefore(this.dropIndicator, target);
      else this.list.append(this.dropIndicator);
    });
    this.list.addEventListener('dragleave', (e) => {
      if (!this.list.contains(e.relatedTarget as Node)) this.dropIndicator.remove();
    });
    this.list.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const at = this.dropIndex(e.clientY);
      this.dropIndicator.remove();
      if (this.dragKeys) {
        this.actions.movePages(this.dragKeys, at);
        this.dragKeys = null;
      } else if (e.dataTransfer?.files.length) this.actions.insertFiles([...e.dataTransfer.files], at);
    });
  }

  private dropIndex(clientY: number) {
    const els = [...this.list.querySelectorAll<HTMLElement>('.thumb')];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return els.length;
  }

  showTab(tab: SidebarTab) {
    this.tab = tab;
    for (const [id, b] of this.tabs) b.classList.toggle('active', id === tab);
    this.list.hidden = tab !== 'pages';
    this.outline.el.hidden = tab !== 'bookmarks';
    this.comments.el.hidden = tab !== 'comments';
    this.comments.visible = tab === 'comments';
    if (tab === 'bookmarks') this.outline.render();
    if (tab === 'comments') this.comments.render(true);
  }

  orderedSelection() {
    return this.model.pages.map((p) => p.key).filter((k) => this.selectedKeys.has(k));
  }

  /** Selected pages, or the current page when nothing is selected. */
  targetKeys() {
    const sel = this.orderedSelection();
    if (sel.length) return sel;
    const cur = this.model.pages[this.viewer.currentIndex];
    return cur ? [cur.key] : [];
  }

  private paintSelection() {
    for (const [k, t] of this.thumbs) t.el.classList.toggle('selected', this.selectedKeys.has(k));
  }

  sync() {
    const keep = new Set(this.model.pages.map((p) => p.key));
    for (const [k, t] of this.thumbs) {
      if (!keep.has(k)) {
        this.io.unobserve(t.el);
        t.el.remove();
        this.thumbs.delete(k);
      }
    }
    for (const k of [...this.selectedKeys]) if (!keep.has(k)) this.selectedKeys.delete(k);
    this.model.pages.forEach((p, i) => {
      let t = this.thumbs.get(p.key);
      if (!t) {
        t = new Thumb(p);
        this.thumbs.set(p.key, t);
        this.io.observe(t.el);
      }
      t.page = p;
      t.layout();
      t.label.textContent = String(i + 1);
      if (t.renderedRotation !== null && t.renderedRotation !== p.rotation) t.render(this.model);
      if (this.list.children[i] !== t.el) this.list.insertBefore(t.el, this.list.children[i] ?? null);
    });
    this.redrawOverlays();
    this.paintSelection();
    this.setCurrent(this.viewer.currentIndex);
  }

  redrawOverlays() {
    const total = this.model.pages.length;
    this.model.pages.forEach((p, i) => {
      const t = this.thumbs.get(p.key);
      if (!t) return;
      t.g.innerHTML = decorSvg(decorations(this.model, p, i, total, textWidth)) + p.annots.map((a) => annotSvg(a, this.model.images, p.rotation)).join('');
    });
    this.comments.invalidate();
  }

  setCurrent(i: number) {
    const key = this.model.pages[i]?.key;
    for (const [k, t] of this.thumbs) t.el.classList.toggle('current', k === key);
    const cur = key && this.thumbs.get(key);
    if (cur && !this.list.hidden) {
      const lr = this.list.getBoundingClientRect();
      const r = cur.el.getBoundingClientRect();
      if (r.top < lr.top || r.bottom > lr.bottom) cur.el.scrollIntoView({ block: 'nearest' });
    }
  }

  clear() {
    for (const t of this.thumbs.values()) this.io.unobserve(t.el);
    this.thumbs.clear();
    this.list.replaceChildren();
    this.selectedKeys.clear();
  }
}
