import { Copy, FileOutput, FilePlus, FolderOpen, RotateCcw, RotateCw, Trash2 } from 'lucide';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { annotLabel, newId } from './annots';
import { compressDialog, digitalSignDialog, type DigitalSignSettings, ocrDialog, redactConfirmDialog, signaturesDialog, splitDialog } from './dialogs';
import { buildPdf, encrypt } from './export';
import type { Pt } from './geom';
import { DocModel, newKey, type OutlineNode, type PageItem } from './model';
import { availableTools, download, native, type OpenedFile, openDialog, openExternal, saveBytes, fromFile } from './native';
import { applyRedactions, ocrPages, pageHasText } from './pagetools';
import { isImageName, isPdf, loadPdf, makeImageAsset, PasswordCancelled } from './pdf';
import { prepareSource } from './pdfimport';
import { Search, TextIndex } from './search';
import { settings } from './settings';
import { Sidebar } from './sidebar';
import { Tools } from './tools';
import { busy, choiceDialog, contextMenu, h, toast } from './ui';
import { Viewer } from './viewer';

type Recent = { path: string; name: string };
export const recentFiles = (): Recent[] => JSON.parse(localStorage.getItem('recent') ?? '[]');
export function addRecent(path: string, name: string) {
  const list = [{ path, name }, ...recentFiles().filter((r) => r.path !== path)].slice(0, 10);
  localStorage.setItem('recent', JSON.stringify(list));
}

type Position = { page: number; scale: number; fit: string | null; at: number };
const POS_KEY = 'positions';

export class Session extends EventTarget {
  readonly model = new DocModel();
  readonly index = new TextIndex(this.model);
  readonly search = new Search(this.model, this.index);
  readonly container: HTMLDivElement;
  readonly viewer: Viewer;
  readonly tools: Tools;
  readonly sidebar: Sidebar;
  /** File bytes as opened, used for signature verification. */
  private original: Uint8Array | null = null;
  private signatureWarned = false;
  private posTimer = 0;
  scroll = { top: 0, left: 0 };

  constructor() {
    super();
    this.container = h('div', { class: 'viewer-container', tabIndex: -1 });
    this.viewer = new Viewer(this.container, this.model, this.index, this.search, {
      openUrl: (url) => openExternal(url),
      goToDest: (src, dest) => this.goToDest(src, dest),
    });
    this.tools = new Tools(this.model, this.viewer, this.index);
    this.sidebar = new Sidebar(this.model, this.viewer, {
      insertFiles: (files, at) => this.insertFiles(files, at),
      pageMenu: (keys, x, y) => this.pageMenu(keys, x, y),
      movePages: (keys, to) => this.movePages(keys, to),
      goTo: (n) => this.goToOutline(n),
      currentTarget: () => this.currentTarget(),
      suggestedTitle: () => this.suggestedTitle(),
      reveal: (id) => this.revealAnnot(id),
      delete: (id) => this.model.edit('annots', () => this.model.pages.forEach((p) => (p.annots = p.annots.filter((a) => a.id !== id)))),
    });
    this.model.addEventListener('change', (e) => {
      const kind = (e as CustomEvent).detail;
      if (kind === 'pages') {
        this.viewer.sync();
        this.sidebar.sync();
        this.sidebar.outline.render();
        if (this.search.query) this.search.run(this.search.query);
      } else if (kind === 'annots') {
        this.viewer.drawOverlays();
        this.sidebar.redrawOverlays();
      } else if (kind === 'meta') this.sidebar.outline.render();
      this.dispatchEvent(new Event('change'));
    });
    this.viewer.addEventListener('pagechange', () => this.savePosition());
    this.viewer.addEventListener('scalechange', () => this.savePosition());
    this.tools.addEventListener('comment', (e) => {
      this.sidebar.showTab('comments');
      this.sidebar.comments.setActive((e as CustomEvent).detail);
      document.body.classList.remove('sidebar-hidden');
    });
    this.tools.addEventListener('selectionchange', () => this.sidebar.comments.setActive([...this.viewer.selected][0] ?? null));
    this.search.addEventListener('change', () => this.viewer.redecorateAll());
  }

  get title() {
    return this.model.loaded ? this.model.name : 'New Tab';
  }

  destroy() {
    clearTimeout(this.posTimer);
    this.viewer.clear();
    this.sidebar.clear();
    this.tools.destroy();
    this.model.destroy();
    this.container.remove();
    this.sidebar.el.remove();
  }

  // ---------------------------------------------------------------- opening

  private async pagesFromPdf(f: OpenedFile, primary: boolean): Promise<PageItem[]> {
    const prep = await prepareSource(f.data, f.name);
    const id = this.model.sources.length;
    this.model.sources.push({ id, name: f.name, bytes: prep.bytes, doc: prep.doc });
    for (const img of prep.images) this.model.images.set(img.id, img);
    (prep.doc.annotationStorage as unknown as { onSetModified: () => void }).onSetModified = () => {
      this.model.dirty = true;
      this.dispatchEvent(new Event('change'));
    };
    if (primary) {
      if (prep.wasEncrypted && prep.password)
        this.model.security = { userPassword: prep.password, ownerPassword: '', print: true, modify: true, copy: true, annotate: true };
      this.model.signatures = prep.signatures;
    }
    const pages: PageItem[] = [];
    for (let i = 0; i < prep.doc.numPages; i++) {
      const p = await prep.doc.getPage(i + 1);
      pages.push({ key: newKey(), src: id, index: i, rotation: p.rotate, view: [...p.view], annots: prep.annots.get(i) ?? [] });
    }
    return pages;
  }

  private async pageFromImage(f: OpenedFile): Promise<PageItem> {
    const asset = await makeImageAsset(f.data);
    this.model.images.set(asset.id, asset);
    // 96 dpi → points, bounded so huge photos still become a sensible page.
    let w = asset.w * 0.75;
    let hh = asset.h * 0.75;
    const k = Math.min(1, 1200 / Math.max(w, hh));
    w *= k;
    hh *= k;
    return {
      key: newKey(),
      src: -1,
      index: 0,
      rotation: 0,
      view: [0, 0, w, hh],
      annots: [{ id: newId(), type: 'image', x: 0, y: 0, w, h: hh, img: asset.id, rot: 0, color: '#000000' }],
    };
  }

  private async pagesFromFiles(files: OpenedFile[], primary: boolean) {
    const out: PageItem[] = [];
    for (const [i, f] of files.entries()) {
      try {
        if (isPdf(f.data)) {
          const srcId = this.model.sources.length;
          const pages = await this.pagesFromPdf(f, primary && i === 0);
          if (primary) this.model.outline.push(...(await this.importOutline(srcId, pages)));
          out.push(...pages);
        } else if (isImageName(f.name)) out.push(await this.pageFromImage(f));
        else toast(`${f.name} is not a PDF or image`, 'error');
      } catch (e) {
        if (e instanceof PasswordCancelled) continue;
        console.error(e);
        toast(`Could not open ${f.name}: ${(e as Error).message}`, 'error');
      }
    }
    return out;
  }

  private async importOutline(src: number, pages: PageItem[]): Promise<OutlineNode[]> {
    const doc = this.model.sources[src].doc;
    const outline = await doc.getOutline().catch(() => null);
    if (!outline) return [];
    type Item = { title: string; dest: unknown; url?: string | null; items: Item[]; count?: number };
    const resolve = async (it: Item): Promise<OutlineNode> => {
      let pageKey: string | null = null;
      let y: number | null = null;
      try {
        const explicit = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
        if (Array.isArray(explicit)) {
          const ref = explicit[0];
          const idx = typeof ref === 'object' && ref ? await doc.getPageIndex(ref) : Number(ref);
          pageKey = pages[idx]?.key ?? null;
          if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') y = explicit[3];
        }
      } catch {
        /* unresolvable destination: keep the bookmark without a target */
      }
      return { id: newId(), title: it.title, pageKey, y, url: it.url ?? null, open: (it.count ?? 0) > 0, children: await Promise.all((it.items ?? []).map(resolve)) };
    };
    return Promise.all((outline as Item[]).map(resolve));
  }

  async open(files: OpenedFile[]): Promise<boolean> {
    busy(`Opening ${files[0].name}…`);
    try {
      const pages = await this.pagesFromFiles(files, true);
      if (!pages.length) return false;
      this.model.pages = pages;
      const single = files.length === 1 && this.model.sources.length === 1;
      this.model.name = single ? files[0].name : files[0].name.replace(/\.[^.]+$/, '') + '.pdf';
      this.model.path = single ? files[0].path : null;
      this.original = single ? files[0].data : null;
      this.model.emit('pages', false);
      this.model.dirty = !single;
      this.viewer.setLayout(settings.layout);
      if (!this.restorePosition()) {
        if (settings.defaultZoom === '1') this.viewer.setScale(1);
        else this.viewer.fit(settings.defaultZoom);
        this.viewer.scrollToPage(0);
      }
      for (const f of files) if (f.path && isPdf(f.data)) addRecent(f.path, f.name);
      if (this.model.signatures.length) this.checkSignatures(true);
      this.dispatchEvent(new Event('change'));
      return true;
    } finally {
      busy(null);
    }
  }

  // ---------------------------------------------------------------- positions

  private posKey() {
    return this.model.path ?? `${this.model.name}:${this.model.sources[0]?.bytes.length ?? 0}`;
  }

  private savePosition() {
    if (!settings.rememberPosition || !this.model.loaded) return;
    clearTimeout(this.posTimer);
    this.posTimer = window.setTimeout(() => {
      const all: Record<string, Position> = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}');
      all[this.posKey()] = { page: this.viewer.currentIndex, scale: this.viewer.scale, fit: this.viewer.fitMode, at: Date.now() };
      const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 200);
      localStorage.setItem(POS_KEY, JSON.stringify(Object.fromEntries(entries)));
    }, 400);
  }

  private restorePosition() {
    if (!settings.rememberPosition) return false;
    const pos: Position | undefined = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}')[this.posKey()];
    if (!pos) return false;
    if (pos.fit === 'width' || pos.fit === 'page') this.viewer.fit(pos.fit);
    else this.viewer.setScale(pos.scale);
    this.viewer.scrollToPage(Math.min(pos.page, this.model.pages.length - 1));
    return true;
  }

  // ---------------------------------------------------------------- navigation

  async goToDest(src: number, dest: unknown) {
    const doc = this.model.sources[src]?.doc;
    if (!doc) return;
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    let index: number;
    try {
      index = typeof ref === 'object' && ref ? await doc.getPageIndex(ref) : Number(ref);
    } catch {
      return;
    }
    const i = this.model.pages.findIndex((p) => p.src === src && p.index === index);
    if (i < 0) return;
    // XYZ destinations carry a target point; jump to it so links land on the right paragraph.
    let pt: Pt | undefined;
    if (explicit[1]?.name === 'XYZ' && typeof explicit[3] === 'number') pt = [explicit[2] ?? 0, explicit[3]];
    this.viewer.scrollToPage(i, pt);
  }

  goToOutline(n: OutlineNode) {
    if (n.url) return openExternal(n.url);
    const i = this.model.pages.findIndex((p) => p.key === n.pageKey);
    if (i >= 0) this.viewer.scrollToPage(i, n.y !== null ? [0, n.y] : undefined);
  }

  private currentTarget() {
    const page = this.model.pages[this.viewer.currentIndex];
    if (!page) return null;
    const v = this.viewer.viewOfKey(page.key);
    let y: number | null = null;
    if (v && page.rotation === 0) {
      const top = this.container.getBoundingClientRect().top;
      const r = v.el.getBoundingClientRect();
      y = Math.round(v.toPdf(r.left, Math.max(top, r.top))[1]);
    }
    return { pageKey: page.key, y };
  }

  private suggestedTitle() {
    const sel = document.getSelection()?.toString().replace(/\s+/g, ' ').trim();
    if (sel && sel.length < 120) return sel;
    return `Page ${this.viewer.currentIndex + 1}`;
  }

  revealAnnot(id: string) {
    const found = this.model.findAnnot(id);
    if (!found) return;
    const i = this.model.pages.indexOf(found.page);
    const v = this.viewer.viewOfKey(found.page.key);
    if (this.tools.tool !== 'select') this.tools.setTool('select');
    this.tools.select([id]);
    if (!v) return;
    this.viewer.scrollToPage(i);
    const sel = v.svg.querySelector('.sel-box');
    if (sel) (sel as SVGElement).scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  // ---------------------------------------------------------------- saving

  private async confirmSignedSave() {
    if (!this.model.signatures.length || this.signatureWarned) return true;
    const r = await choiceDialog(
      'This document is digitally signed',
      'Saving rewrites the file, which invalidates the existing signatures. Consider saving a copy instead.',
      ['Save Anyway', 'Save a Copy…', 'Cancel'],
      1,
    );
    if (r === 0) this.signatureWarned = true;
    return r === 0 ? true : r === 1 ? 'copy' : false;
  }

  async save(saveAs: boolean): Promise<boolean> {
    if (!this.model.loaded) return false;
    const ok = await this.confirmSignedSave();
    if (!ok) return false;
    if (ok === 'copy') saveAs = true;
    busy('Saving…');
    try {
      const bytes = await buildPdf(this.model);
      busy(null);
      const res = await saveBytes(bytes, this.model.name, ok === 'copy' ? null : this.model.path, saveAs || !this.model.path);
      if (!res) return false;
      this.model.path = res.path;
      this.model.name = res.name;
      this.model.dirty = false;
      if (res.path) addRecent(res.path, res.name);
      this.dispatchEvent(new Event('change'));
      toast(native ? `Saved ${res.name}` : `Downloaded ${res.name}`);
      return true;
    } catch (e) {
      console.error(e);
      toast(`Save failed: ${(e as Error).message}`, 'error');
      return false;
    } finally {
      busy(null);
    }
  }

  get baseName() {
    return this.model.name.replace(/\.pdf$/i, '');
  }

  async exportPages(keys: string[]) {
    const pages = this.model.pages.filter((p) => keys.includes(p.key));
    if (!pages.length) return;
    busy('Exporting…');
    try {
      const bytes = await buildPdf(this.model, pages);
      busy(null);
      const res = await saveBytes(bytes, `${this.baseName} (pages).pdf`, null, true);
      if (res) toast(`Exported ${pages.length} page${pages.length > 1 ? 's' : ''}`);
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
    }
  }

  async print() {
    if (!this.model.loaded) return;
    busy('Preparing to print…');
    const root = document.getElementById('print-root')!;
    const urls: string[] = [];
    try {
      const doc = await loadPdf(await buildPdf(this.model, this.model.pages, { print: true }), 'print');
      root.replaceChildren();
      for (let i = 1; i <= doc.numPages; i++) {
        busy(`Preparing page ${i} of ${doc.numPages}…`);
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const c = document.createElement('canvas');
        c.width = vp.width;
        c.height = vp.height;
        await page.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.92));
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const img = h('img', { src: url });
        await img.decode();
        root.append(h('div', { class: 'print-page' }, img));
      }
      doc.loadingTask.destroy();
      busy(null);
      window.print();
    } catch (e) {
      toast(`Print failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
      root.replaceChildren();
      urls.forEach(URL.revokeObjectURL);
    }
  }

  async split(spec: Awaited<ReturnType<typeof splitDialog>>) {
    if (!spec) return;
    const pages = this.model.pages;
    let groups: PageItem[][];
    if (spec.mode === 'every') {
      groups = [];
      for (let i = 0; i < pages.length; i += spec.n) groups.push(pages.slice(i, i + spec.n));
    } else if (spec.mode === 'ranges') groups = spec.ranges.map((r) => r.map((i) => pages[i]));
    else {
      const starts = [...new Set(this.model.outline.map((n) => pages.findIndex((p) => p.key === n.pageKey)).filter((i) => i >= 0))].sort((a, b) => a - b);
      if (starts[0] !== 0) starts.unshift(0);
      groups = starts.map((s, i) => pages.slice(s, starts[i + 1] ?? pages.length));
    }
    groups = groups.filter((g) => g.length);
    const dir = native ? await native.chooseDir() : '';
    if (dir === null) return;
    try {
      for (const [i, g] of groups.entries()) {
        busy(`Writing part ${i + 1} of ${groups.length}…`);
        const bytes = await buildPdf(this.model, g);
        const name = `${this.baseName}-part${String(i + 1).padStart(String(groups.length).length, '0')}.pdf`;
        if (native) await native.writeFile(`${dir}/${name}`, bytes);
        else download(bytes, name);
      }
      toast(`Split into ${groups.length} files`);
    } catch (e) {
      toast(`Split failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
    }
  }

  async compress() {
    busy('Measuring…');
    let bytes: Uint8Array;
    try {
      bytes = await buildPdf(this.model, this.model.pages, { noSecurity: true });
    } finally {
      busy(null);
    }
    const mode = await compressDialog(bytes.length);
    if (!mode || !native) return;
    busy('Reducing file size…');
    try {
      let out =
        mode === 'lossless'
          ? await native.qpdf(['--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9'], bytes)
          : await native.ghostscript(bytes, mode);
      if (out.length >= bytes.length) {
        busy(null);
        toast('The file is already as small as this method can make it');
        return;
      }
      out = await encrypt(this.model, out);
      busy(null);
      const pct = Math.round((1 - out.length / bytes.length) * 100);
      const res = await saveBytes(out, `${this.baseName}-compressed.pdf`, null, true);
      if (res) toast(`Saved ${res.name}: ${(out.length / 1048576).toFixed(2)} MB (−${pct}%)`);
    } catch (e) {
      toast(`Compression failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
    }
  }

  async ocr() {
    const sel = this.sidebar.orderedSelection();
    const opts = await ocrDialog(sel.length > 1);
    if (!opts) return;
    let pages = opts.scope === 'all' ? this.model.pages : opts.scope === 'selected' ? this.model.pages.filter((p) => sel.includes(p.key)) : [this.model.pages[this.viewer.currentIndex]];
    try {
      if (opts.skipText) {
        busy('Checking pages…');
        const keep: PageItem[] = [];
        for (const p of pages) if (!(await pageHasText(this.index, p))) keep.push(p);
        pages = keep;
      }
      if (!pages.length) {
        toast('All pages already contain text');
        return;
      }
      const n = await ocrPages(this.model, pages, opts.lang, (m) => busy(m));
      toast(`Recognized text on ${n} page${n > 1 ? 's' : ''}`);
    } catch (e) {
      toast(`OCR failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
    }
  }

  async applyRedactions() {
    const count = this.model.pages.filter((p) => p.annots.some((a) => a.type === 'redact')).length;
    if (!count) {
      toast('Mark areas with the Redact tool first (select text, or drag over an area)');
      return;
    }
    const r = await redactConfirmDialog(count);
    if (!r) return;
    try {
      const n = await applyRedactions(this.model, this.index, (m) => busy(m));
      if (r.sanitize) this.model.sanitize = true;
      toast(`Redacted ${n} page${n > 1 ? 's' : ''}. Save to make it permanent.`);
    } catch (e) {
      console.error(e);
      toast(`Redaction failed: ${(e as Error).message}`, 'error');
    } finally {
      busy(null);
    }
  }

  async checkSignatures(quiet = false) {
    if (!native) return;
    const data = this.original ?? this.model.sources[0]?.bytes;
    if (!data) return;
    const list = await native.verifySignatures(data);
    if (quiet) {
      if (!list.length) return;
      const bad = list.filter((s) => !s.intact);
      toast(bad.length ? `Warning: ${bad.length} signature(s) are INVALID` : `Signed by ${list.map((s) => s.signer).join(', ')} — signatures valid`, bad.length ? 'error' : 'info');
      return;
    }
    await signaturesDialog(list);
  }

  async digitalSign() {
    const opts = await digitalSignDialog();
    if (!opts) return;
    toast('Drag a rectangle where the signature should appear');
    const picked = await this.tools.pickRect();
    if (!picked) return;
    const pageIndex = this.model.pages.indexOf(picked.view.page);
    busy('Signing…');
    try {
      let bytes = await buildPdf(this.model, this.model.pages, { noSecurity: true });
      bytes = await drawSignatureAppearance(bytes, pageIndex, picked.box, picked.view.page.rotation, opts);
      const b = picked.box;
      const signed = await native!.signPdf({ ...opts, data: bytes, pageIndex, rect: [b.x, b.y, b.x + b.w, b.y + b.h] });
      busy(null);
      if (this.model.security) toast('Note: password protection is not applied to signed copies', 'error');
      const res = await saveBytes(signed, `${this.baseName}-signed.pdf`, null, true);
      if (res) toast(`Signed and saved ${res.name}`);
    } catch (e) {
      const msg = (e as Error).message;
      toast(/mac|password|decrypt|Invalid/i.test(msg) ? 'Wrong password for this digital ID' : `Signing failed: ${msg}`, 'error');
    } finally {
      busy(null);
    }
  }

  // ---------------------------------------------------------------- pages

  rotatePages(keys: string[], delta: number) {
    if (!keys.length) return;
    this.model.edit('pages', () => {
      for (const p of this.model.pages) if (keys.includes(p.key)) p.rotation = (((p.rotation + delta) % 360) + 360) % 360;
    });
    if (this.viewer.fitMode) this.viewer.fit(this.viewer.fitMode);
  }

  deletePages(keys: string[]) {
    if (keys.length >= this.model.pages.length) {
      toast('A document must keep at least one page', 'error');
      return;
    }
    this.model.edit('pages', () => (this.model.pages = this.model.pages.filter((p) => !keys.includes(p.key))));
  }

  duplicatePages(keys: string[]) {
    this.model.edit('pages', () => {
      const out: PageItem[] = [];
      for (const p of this.model.pages) {
        out.push(p);
        if (!keys.includes(p.key)) continue;
        const c: PageItem = JSON.parse(JSON.stringify(p));
        c.key = newKey();
        c.annots.forEach((a) => (a.id = newId()));
        out.push(c);
      }
      this.model.pages = out;
    });
  }

  insertBlank(afterKey?: string) {
    const i = afterKey ? this.model.pages.findIndex((p) => p.key === afterKey) : this.viewer.currentIndex;
    const ref = this.model.pages[i];
    const [x0, y0, x1, y1] = ref?.view ?? [0, 0, 612, 792];
    const page: PageItem = { key: newKey(), src: -1, index: 0, rotation: ref?.rotation ?? 0, view: [0, 0, x1 - x0, y1 - y0], annots: [] };
    this.model.edit('pages', () => this.model.pages.splice(i + 1, 0, page));
    this.viewer.scrollToPage(i + 1);
  }

  movePages(keys: string[], to: number) {
    this.model.edit('pages', () => {
      const moving = this.model.pages.filter((p) => keys.includes(p.key));
      const before = this.model.pages.slice(0, to).filter((p) => !keys.includes(p.key));
      const after = this.model.pages.slice(to).filter((p) => !keys.includes(p.key));
      this.model.pages = [...before, ...moving, ...after];
    });
  }

  async insertOpened(files: OpenedFile[], at: number) {
    if (!files.length) return;
    busy('Inserting pages…');
    try {
      const pages = await this.pagesFromFiles(files, false);
      if (!pages.length) return;
      this.model.edit('pages', () => this.model.pages.splice(at, 0, ...pages));
      toast(`Inserted ${pages.length} page${pages.length > 1 ? 's' : ''}`);
    } finally {
      busy(null);
    }
  }

  async insertFiles(files: File[], at: number) {
    await this.insertOpened(await Promise.all(files.map(fromFile)), at);
  }

  pageMenu(keys: string[], x: number, y: number) {
    const n = keys.length;
    const s = n > 1 ? `${n} pages` : 'page';
    const lastIdx = Math.max(...keys.map((k) => this.model.pages.findIndex((p) => p.key === k)));
    contextMenu(x, y, [
      { label: `Rotate ${s} clockwise`, icon: RotateCw, action: () => this.rotatePages(keys, 90) },
      { label: `Rotate ${s} counterclockwise`, icon: RotateCcw, action: () => this.rotatePages(keys, -90) },
      'sep',
      { label: `Duplicate ${s}`, icon: Copy, action: () => this.duplicatePages(keys) },
      { label: 'Insert blank page after', icon: FilePlus, action: () => this.insertBlank(this.model.pages[lastIdx]?.key) },
      { label: 'Insert pages from file after…', icon: FolderOpen, action: async () => this.insertOpened(await openDialog(), lastIdx + 1) },
      { label: `Export ${s}…`, icon: FileOutput, action: () => this.exportPages(keys) },
      'sep',
      { label: `Delete ${s}`, icon: Trash2, danger: true, action: () => this.deletePages(keys), disabled: n >= this.model.pages.length },
    ]);
  }

  describeSelection() {
    const sel = this.tools.selection;
    return sel.length === 1 ? annotLabel(sel[0]) : sel.length ? `${sel.length} items` : '';
  }

  async ensureTools() {
    return availableTools();
  }
}

/** Draws the visible part of a certificate signature (the cryptographic part is added by the main process). */
async function drawSignatureAppearance(bytes: Uint8Array, pageIndex: number, box: { x: number; y: number; w: number; h: number }, rotation: number, opts: DigitalSignSettings) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPage(pageIndex);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const lines: [string, typeof reg, number][] = [
    [opts.name, bold, 0],
    ['Digitally signed', reg, 0],
    [new Date().toLocaleString(), reg, 0],
  ];
  if (opts.reason) lines.push([`Reason: ${opts.reason}`, reg, 0]);
  if (opts.location) lines.push([`Location: ${opts.location}`, reg, 0]);
  const vertical = rotation % 180 !== 0;
  const W = vertical ? box.h : box.w;
  const H = vertical ? box.w : box.h;
  const size = Math.max(5, Math.min(14, (H - 6) / (lines.length * 1.25)));
  lines.forEach((l) => (l[2] = Math.min(size, ((W - 8) / Math.max(1, l[1].widthOfTextAtSize(l[0].replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), 1))) * 0.98)));
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: rgb(0.11, 0.3, 0.85), borderWidth: 1, color: rgb(0.93, 0.96, 1), opacity: 0.9 });
  // Lay text out in the page's displayed orientation, starting from its visual top-left corner.
  const r = ((rotation % 360) + 360) % 360;
  const origin = ({ 0: [box.x, box.y + box.h], 90: [box.x, box.y], 180: [box.x + box.w, box.y], 270: [box.x + box.w, box.y + box.h] } as Record<number, number[]>)[r];
  const rad = (r * Math.PI) / 180;
  let dy = 3;
  for (const [text, font, s] of lines) {
    dy += s * 1.2;
    const lx = 4,
      ly = -dy + s * 0.2;
    page.drawText(text.replace(/[^\x20-\x7e\xa0-\xff]/g, '?'), {
      x: origin[0] + lx * Math.cos(rad) - ly * Math.sin(rad),
      y: origin[1] + lx * Math.sin(rad) + ly * Math.cos(rad),
      size: s,
      font,
      color: rgb(0.08, 0.17, 0.45),
      rotate: degrees(r),
    });
  }
  return doc.save({ useObjectStreams: false });
}
