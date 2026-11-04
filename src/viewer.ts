import { AnnotationLayer, AnnotationMode, RenderingCancelledException, TextLayer } from 'pdfjs-dist';
import type { RenderTask } from 'pdfjs-dist';
import { annotSvg, bbox, canResize, textWidth } from './annots';
import { decorations, decorSvg } from './decor';
import { settings, UNIT_PT, type Layout } from './settings';
import { apply, type Geom, invert, matStr, pageGeom, type Pt } from './geom';
import type { DocModel, PageItem } from './model';
import type { Search, TextIndex } from './search';

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_CANVAS_PIXELS = 16_777_216;
const PAGE_GAP = 14;
const PAD = 24;

export type FitMode = 'width' | 'page' | null;

export interface LinkHandler {
  goToDest(src: number, dest: unknown): void;
  openUrl(url: string): void;
}

export class PageView {
  el: HTMLDivElement;
  svg: SVGSVGElement;
  gridG: SVGGElement;
  annotG: SVGGElement;
  draftG: SVGGElement;
  selG: SVGGElement;
  canvas: HTMLCanvasElement | null = null;
  textDiv: HTMLDivElement | null = null;
  formDiv: HTMLDivElement | null = null;
  textLayer: TextLayer | null = null;
  geom!: Geom;
  inv!: ReturnType<typeof invert>;
  rendered: { scale: number; rotation: number; src: number; index: number } | null = null;
  private task: RenderTask | null = null;
  private renderSeq = 0;
  hiddenAnnot: string | null = null;

  constructor(public page: PageItem) {
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.dataset.key = page.key;
    this.svg = document.createElementNS(SVGNS, 'svg');
    this.svg.classList.add('overlay');
    this.gridG = document.createElementNS(SVGNS, 'g');
    this.annotG = document.createElementNS(SVGNS, 'g');
    this.draftG = document.createElementNS(SVGNS, 'g');
    this.selG = document.createElementNS(SVGNS, 'g');
    this.svg.append(this.gridG, this.annotG, this.draftG, this.selG);
    this.el.append(this.svg);
  }

  layout(scale: number) {
    this.geom = pageGeom(this.page.view, scale, this.page.rotation);
    this.inv = invert(this.geom.transform);
    this.el.style.width = `${Math.floor(this.geom.width)}px`;
    this.el.style.height = `${Math.floor(this.geom.height)}px`;
    this.el.style.setProperty('--scale-factor', String(scale));
    this.svg.setAttribute('width', String(this.geom.width));
    this.svg.setAttribute('height', String(this.geom.height));
    const t = matStr(this.geom.transform);
    this.annotG.setAttribute('transform', t);
    this.draftG.setAttribute('transform', t);
  }

  get stale() {
    return !this.rendered || this.rendered.scale !== this.scale || this.rendered.rotation !== this.page.rotation;
  }

  get scale() {
    return parseFloat(this.el.style.getPropertyValue('--scale-factor'));
  }

  toPdf(clientX: number, clientY: number): Pt {
    const r = this.el.getBoundingClientRect();
    return apply(this.inv, clientX - r.left, clientY - r.top);
  }

  toScreen(x: number, y: number): Pt {
    return apply(this.geom.transform, x, y);
  }

  cancel() {
    this.renderSeq++;
    this.task?.cancel();
    this.task = null;
    this.textLayer?.cancel();
  }

  release() {
    this.cancel();
    this.canvas?.remove();
    this.textDiv?.remove();
    this.formDiv?.remove();
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = this.textDiv = this.formDiv = null;
    this.textLayer = null;
    this.rendered = null;
  }

  async render(model: DocModel, index: TextIndex, links: LinkHandler, afterText: (v: PageView) => void) {
    this.cancel();
    const seq = this.renderSeq;
    const scale = this.scale;
    const rotation = this.page.rotation;
    const page = this.page;
    if (page.src < 0) {
      this.rendered = { scale, rotation, src: page.src, index: page.index };
      return;
    }
    const src = model.sources[page.src];
    const proxy = await src.doc.getPage(page.index + 1);
    if (seq !== this.renderSeq) return;
    const vp = proxy.getViewport({ scale, rotation });

    let dpr = window.devicePixelRatio || 1;
    const px = vp.width * vp.height * dpr * dpr;
    if (px > MAX_CANVAS_PIXELS) dpr *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    this.task = proxy.render({
      canvas,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      annotationMode: AnnotationMode.ENABLE_FORMS,
    });
    try {
      await this.task.promise;
    } catch (e) {
      if (e instanceof RenderingCancelledException) return;
      throw e;
    }
    if (seq !== this.renderSeq) return;
    // Swap only once the new bitmap is ready so zooming never flashes a blank page.
    if (this.canvas) {
      this.canvas.replaceWith(canvas);
      this.canvas.width = this.canvas.height = 0;
    } else this.el.prepend(canvas);
    this.canvas = canvas;
    this.rendered = { scale, rotation, src: page.src, index: page.index };

    const pt = await index.get(page.src, page.index);
    if (!pt || seq !== this.renderSeq) return;
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    const tl = new TextLayer({ textContentSource: pt.content, container: textDiv, viewport: vp });
    try {
      await tl.render();
    } catch {
      return;
    }
    if (seq !== this.renderSeq) return;
    const end = document.createElement('div');
    end.className = 'endOfContent';
    textDiv.append(end);
    if (this.textDiv) this.textDiv.replaceWith(textDiv);
    else canvas.after(textDiv);
    this.textDiv = textDiv;
    this.textLayer = tl;
    afterText(this);

    const annotations = await proxy.getAnnotations({ intent: 'display' });
    if (seq !== this.renderSeq) return;
    if (!annotations.length) {
      this.formDiv?.remove();
      this.formDiv = null;
      return;
    }
    const formDiv = document.createElement('div');
    formDiv.className = 'annotationLayer';
    const linkService = makeLinkService(page.src, links);
    const avp = vp.clone({ dontFlip: true });
    const layer = new AnnotationLayer({
      div: formDiv,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      page: proxy,
      viewport: avp,
      structTreeLayer: null,
      commentManager: null,
      linkService,
      annotationStorage: src.doc.annotationStorage,
    });
    try {
      await layer.render({
        annotations,
        viewport: avp,
        div: formDiv,
        page: proxy,
        linkService: linkService as never,
        renderForms: true,
        annotationStorage: src.doc.annotationStorage,
        imageResourcesPath: new URL('pdfjs/images/', document.baseURI).href,
        enableScripting: false,
        hasJSActions: false,
        fieldObjects: null,
      });
    } catch (e) {
      console.warn('annotation layer failed', e);
      return;
    }
    if (seq !== this.renderSeq) return;
    if (this.formDiv) this.formDiv.replaceWith(formDiv);
    else this.svg.before(formDiv);
    this.formDiv = formDiv;
  }

  drawOverlay(model: DocModel, selected: Set<string>, index: number, total: number) {
    const decor = decorSvg(decorations(model, this.page, index, total, textWidth));
    this.annotG.innerHTML =
      `<g class="decor">${decor}</g>` +
      this.page.annots
        .filter((a) => a.id !== this.hiddenAnnot)
        .map((a) => annotSvg(a, model.images, this.page.rotation))
        .join('');
    this.drawGrid();
    let sel = '';
    for (const a of this.page.annots) {
      if (!selected.has(a.id) || a.id === this.hiddenAnnot) continue;
      const b = bbox(a);
      const p1 = this.toScreen(b.x, b.y);
      const p2 = this.toScreen(b.x + b.w, b.y + b.h);
      const x = Math.min(p1[0], p2[0]) - 3;
      const y = Math.min(p1[1], p2[1]) - 3;
      const w = Math.abs(p1[0] - p2[0]) + 6;
      const hh = Math.abs(p1[1] - p2[1]) + 6;
      sel += `<rect class="sel-box" data-id="${a.id}" x="${x}" y="${y}" width="${w}" height="${hh}"/>`;
      if (canResize(a) && selected.size === 1)
        sel += `<rect class="sel-handle" data-handle="${a.id}" x="${x + w - 5}" y="${y + hh - 5}" width="10" height="10"/>`;
    }
    this.selG.innerHTML = sel;
  }

  /** Grid lines every settings.gridSize units, anchored at the page's displayed top-left corner. */
  drawGrid() {
    if (!settings.grid) {
      this.gridG.innerHTML = '';
      return;
    }
    const step = settings.gridSize * UNIT_PT[settings.units] * this.scale;
    if (step < 4) {
      this.gridG.innerHTML = '';
      return;
    }
    const { width, height } = this.geom;
    let d = '';
    for (let x = step; x < width; x += step) d += `M${x.toFixed(1)} 0V${height.toFixed(1)}`;
    for (let y = step; y < height; y += step) d += `M0 ${y.toFixed(1)}H${width.toFixed(1)}`;
    this.gridG.innerHTML = `<path class="grid" d="${d}"/>`;
  }
}

function makeLinkService(src: number, links: LinkHandler) {
  return {
    eventBus: null,
    externalLinkEnabled: true,
    pagesCount: 0,
    page: 1,
    rotation: 0,
    isInPresentationMode: false,
    addLinkAttributes(link: HTMLAnchorElement, url: string) {
      link.href = url;
      link.title = url;
      link.rel = 'noopener noreferrer nofollow';
      link.onclick = (e) => {
        e.preventDefault();
        links.openUrl(url);
        return false;
      };
    },
    getDestinationHash: () => '#',
    getAnchorUrl: () => '#',
    goToDestination: async (dest: unknown) => links.goToDest(src, dest),
    goToPage() {},
    executeNamedAction() {},
    executeSetOCGState() {},
    getAttachmentContent: async () => null,
  };
}

export class Viewer extends EventTarget {
  readonly root: HTMLDivElement;
  views = new Map<string, PageView>();
  order: PageView[] = [];
  scale = 1;
  fitMode: FitMode = 'width';
  layout: Layout = 'continuous';
  currentIndex = 0;
  selected = new Set<string>();
  private visible = new Set<PageView>();
  private io: IntersectionObserver;
  private renderPending = false;
  private rendering = 0;

  constructor(
    readonly container: HTMLElement,
    private model: DocModel,
    private index: TextIndex,
    private search: Search,
    private links: LinkHandler,
  ) {
    super();
    this.root = document.createElement('div');
    this.root.className = 'pdfViewer';
    container.append(this.root);
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = this.order.find((o) => o.el === e.target);
          if (!v) continue;
          if (e.isIntersecting) this.visible.add(v);
          else {
            this.visible.delete(v);
            v.release();
          }
        }
        this.scheduleRender();
      },
      { root: container, rootMargin: '150% 0px' },
    );
    let raf = 0;
    container.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => this.updateCurrent());
    });
    let lastFlip = 0;
    container.addEventListener(
      'wheel',
      (e) => {
        if (this.layout !== 'single' || e.ctrlKey) return;
        const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
        const atTop = container.scrollTop <= 0;
        const dir = e.deltaY > 0 && atBottom ? 1 : e.deltaY < 0 && atTop ? -1 : 0;
        const next = this.currentIndex + dir;
        if (!dir || next < 0 || next >= this.order.length) return;
        e.preventDefault();
        if (Date.now() - lastFlip < 350) return;
        lastFlip = Date.now();
        this.scrollToPage(next);
      },
      { passive: false },
    );
    new ResizeObserver(() => {
      if (this.fitMode && this.order.length) this.applyFit(true);
    }).observe(container);
  }

  /** Reconciles page views with the model, reusing views (and their bitmaps) by page key. */
  sync() {
    const keep = new Set(this.model.pages.map((p) => p.key));
    for (const [k, v] of this.views) {
      if (!keep.has(k)) {
        this.io.unobserve(v.el);
        this.visible.delete(v);
        v.release();
        v.el.remove();
        this.views.delete(k);
      }
    }
    this.order = this.model.pages.map((p) => {
      let v = this.views.get(p.key);
      if (!v) {
        v = new PageView(p);
        this.views.set(p.key, v);
        this.io.observe(v.el);
      }
      if (v.rendered && (v.rendered.src !== p.src || v.rendered.index !== p.index)) v.release();
      v.page = p;
      v.layout(this.scale);
      return v;
    });
    this.order.forEach((v, i) => {
      if (this.root.children[i] !== v.el) this.root.insertBefore(v.el, this.root.children[i] ?? null);
      v.el.dataset.index = String(i);
    });
    for (const k of [...this.selected]) if (!this.model.findAnnot(k)) this.selected.delete(k);
    this.currentIndex = Math.min(this.currentIndex, Math.max(0, this.order.length - 1));
    this.updateLayoutWidth();
    this.markCurrent();
    this.drawOverlays();
    this.updateCurrent();
    this.scheduleRender();
  }

  clear() {
    for (const v of this.views.values()) {
      this.io.unobserve(v.el);
      v.release();
      v.el.remove();
    }
    this.views.clear();
    this.order = [];
    this.visible.clear();
    this.selected.clear();
    this.currentIndex = 0;
  }

  drawOverlays(only?: PageView) {
    const total = this.order.length;
    for (const v of only ? [only] : this.order) v.drawOverlay(this.model, this.selected, this.order.indexOf(v), total);
  }

  viewOfKey(key: string) {
    return this.views.get(key);
  }

  private scheduleRender() {
    if (this.renderPending) return;
    this.renderPending = true;
    requestAnimationFrame(() => {
      this.renderPending = false;
      this.pump();
    });
  }

  private pump() {
    const cRect = this.container.getBoundingClientRect();
    const mid = cRect.top + cRect.height / 2;
    const queue = [...this.visible]
      .filter((v) => v.stale)
      .sort((a, b) => {
        const ra = a.el.getBoundingClientRect();
        const rb = b.el.getBoundingClientRect();
        return Math.abs(ra.top + ra.height / 2 - mid) - Math.abs(rb.top + rb.height / 2 - mid);
      });
    while (this.rendering < 2 && queue.length) {
      const v = queue.shift()!;
      this.rendering++;
      const scale = this.scale;
      v.render(this.model, this.index, this.links, (pv) => this.decorate(pv))
        .catch((e) => console.error('render failed', e))
        .finally(() => {
          this.rendering--;
          // A zoom during render leaves this view stale; the next pump picks it up again.
          if (scale !== this.scale || queue.length || [...this.visible].some((x) => x.stale)) this.scheduleRender();
        });
    }
  }

  /** Re-applies search highlights; returns the element of the current match if it is on this page. */
  decorate(v: PageView) {
    if (!v.textLayer) return null;
    const pt = this.index.get(v.page.src, v.page.index);
    if (!pt) return null;
    let el: HTMLElement | null = null;
    pt.then((t) => {
      if (!v.textLayer) return;
      el = this.search.decorate(v.page.key, t, v.textLayer.textDivs, v.textLayer.textContentItemsStr);
      if (el && this.pendingReveal === v.page.key) {
        this.pendingReveal = null;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
    });
    return el;
  }

  private pendingReveal: string | null = null;

  redecorateAll() {
    for (const v of this.order) this.decorate(v);
  }

  revealMatch(pageKey: string) {
    const v = this.views.get(pageKey);
    if (!v) return;
    this.pendingReveal = pageKey;
    if (v.textLayer) this.decorate(v);
    else v.el.scrollIntoView({ block: 'center' });
  }

  setLayout(layout: Layout) {
    const idx = this.currentIndex;
    this.layout = layout;
    this.root.classList.toggle('facing', layout === 'facing');
    this.root.classList.toggle('single', layout === 'single');
    this.updateLayoutWidth();
    this.markCurrent();
    if (this.fitMode) this.applyFit(false);
    this.scrollToPage(idx);
    this.scheduleRender();
  }

  /** In two-page mode the root is sized so exactly two of the widest pages fit per row. */
  private updateLayoutWidth() {
    if (this.layout !== 'facing') {
      this.root.style.width = '';
      return;
    }
    const widest = Math.max(0, ...this.order.map((v) => v.geom.width));
    this.root.style.width = `${Math.ceil(widest * 2 + PAGE_GAP + PAD * 2 + 1)}px`;
  }

  private markCurrent() {
    this.order.forEach((v, i) => v.el.classList.toggle('current-page', i === this.currentIndex));
  }

  private updateCurrent() {
    if (this.layout === 'single') return;
    const top = this.container.scrollTop + this.container.clientHeight * 0.35;
    let idx = 0;
    for (let i = 0; i < this.order.length; i++) {
      if (this.order[i].el.offsetTop <= top) idx = i;
      else break;
    }
    if (idx !== this.currentIndex) {
      this.currentIndex = idx;
      this.markCurrent();
      this.dispatchEvent(new Event('pagechange'));
    }
  }

  scrollToPage(i: number, pdfPoint?: Pt) {
    const v = this.order[Math.max(0, Math.min(i, this.order.length - 1))];
    if (!v) return;
    if (this.layout === 'single') {
      this.currentIndex = this.order.indexOf(v);
      this.markCurrent();
    }
    let top = v.el.offsetTop - PAGE_GAP / 2;
    if (pdfPoint) top = v.el.offsetTop + v.toScreen(pdfPoint[0], pdfPoint[1])[1] - 20;
    this.container.scrollTo({ top: this.layout === 'single' && !pdfPoint ? 0 : top });
    this.currentIndex = this.order.indexOf(v);
    this.markCurrent();
    this.dispatchEvent(new Event('pagechange'));
  }

  setScale(scale: number, anchor?: { clientX: number; clientY: number }, keepFit = false) {
    scale = Math.max(0.1, Math.min(8, scale));
    if (!keepFit) this.fitMode = null;
    if (!this.order.length) {
      this.scale = scale;
      return;
    }
    const c = this.container;
    const cr = c.getBoundingClientRect();
    const mx = anchor ? anchor.clientX - cr.left : c.clientWidth / 2;
    const my = anchor ? anchor.clientY - cr.top : 0;
    const v = this.order[this.currentIndex] ?? this.order[0];
    const rx = (c.scrollLeft + mx - v.el.offsetLeft) / v.el.offsetWidth;
    const ry = (c.scrollTop + my - v.el.offsetTop) / v.el.offsetHeight;
    this.scale = scale;
    for (const o of this.order) o.layout(scale);
    this.updateLayoutWidth();
    c.scrollLeft = v.el.offsetLeft + rx * v.el.offsetWidth - mx;
    c.scrollTop = v.el.offsetTop + ry * v.el.offsetHeight - my;
    this.drawOverlays();
    this.scheduleRender();
    this.dispatchEvent(new Event('scalechange'));
  }

  zoomStep(dir: 1 | -1, anchor?: { clientX: number; clientY: number }) {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
    const cur = this.scale;
    const next = dir > 0 ? steps.find((s) => s > cur + 0.001) : [...steps].reverse().find((s) => s < cur - 0.001);
    this.setScale(next ?? cur, anchor);
  }

  fit(mode: Exclude<FitMode, null>) {
    this.fitMode = mode;
    this.applyFit(false);
  }

  private applyFit(fromResize: boolean) {
    const v = this.order[this.currentIndex] ?? this.order[0];
    if (!v || !this.fitMode) return;
    const g = pageGeom(v.page.view, 1, v.page.rotation);
    const availW = this.container.clientWidth - PAD * 2;
    const availH = this.container.clientHeight - PAGE_GAP * 2;
    let s = availW / (this.layout === 'facing' ? g.width * 2 + PAGE_GAP : g.width);
    if (this.fitMode === 'page') s = Math.min(s, availH / g.height);
    if (fromResize && Math.abs(s - this.scale) < 0.005) return;
    this.setScale(s, undefined, true);
    if (this.fitMode === 'page' && !fromResize) this.scrollToPage(this.currentIndex);
  }

  viewAt(clientX: number, clientY: number) {
    for (const v of this.order) {
      const r = v.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return v;
    }
    return null;
  }
}
