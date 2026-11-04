import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Annot, FontName, ImageAsset } from './annots';
import { authorName } from './settings';

export interface Source {
  id: number;
  name: string;
  bytes: Uint8Array;
  doc: PDFDocumentProxy;
}

export interface PageItem {
  key: string;
  /** Index into DocModel.sources, or -1 for a page created in the editor. */
  src: number;
  index: number;
  /** Total page rotation (not a delta), in degrees clockwise like PDF /Rotate. */
  rotation: number;
  view: number[];
  annots: Annot[];
}

export interface OutlineNode {
  id: string;
  title: string;
  pageKey: string | null;
  /** Target y in PDF user space (top of view), if the destination had one. */
  y: number | null;
  url?: string | null;
  children: OutlineNode[];
  open?: boolean;
}

export interface HeaderFooter {
  header: [string, string, string];
  footer: [string, string, string];
  size: number;
  margin: number;
  color: string;
  font: FontName;
  start: number;
  skipFirst: boolean;
}

export interface Watermark {
  text: string;
  size: number;
  color: string;
  opacity: number;
  angle: number;
  font: FontName;
}

export interface Security {
  userPassword: string;
  ownerPassword: string;
  print: boolean;
  modify: boolean;
  copy: boolean;
  annotate: boolean;
}

export interface SignatureInfo {
  field: string;
  name?: string;
  date?: string;
  reason?: string;
  location?: string;
  status?: string;
  valid?: boolean;
}

interface Snapshot {
  pages: PageItem[];
  outline: OutlineNode[];
  headerFooter: HeaderFooter | null;
  watermark: Watermark | null;
  outlineEdited: boolean;
}

export type ChangeKind = 'annots' | 'pages' | 'meta';

let keySeq = 0;
export const newKey = () => `p${++keySeq}`;

export class DocModel extends EventTarget {
  sources: Source[] = [];
  pages: PageItem[] = [];
  images = new Map<string, ImageAsset>();
  outline: OutlineNode[] = [];
  outlineEdited = false;
  headerFooter: HeaderFooter | null = null;
  watermark: Watermark | null = null;
  security: Security | null = null;
  /** Strip document metadata (title, author, XMP) on save. */
  sanitize = false;
  signatures: SignatureInfo[] = [];
  name = 'Untitled.pdf';
  path: string | null = null;
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  get loaded() {
    return this.pages.length > 0;
  }

  private snapshot() {
    const s: Snapshot = {
      pages: this.pages,
      outline: this.outline,
      headerFooter: this.headerFooter,
      watermark: this.watermark,
      outlineEdited: this.outlineEdited,
    };
    return JSON.stringify(s);
  }

  private restore(json: string) {
    const s: Snapshot = JSON.parse(json);
    this.pages = s.pages;
    this.outline = s.outline;
    this.headerFooter = s.headerFooter;
    this.watermark = s.watermark;
    this.outlineEdited = s.outlineEdited;
  }

  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
  }

  emit(kind: ChangeKind, markDirty = true) {
    if (markDirty) this.dirty = true;
    this.dispatchEvent(new CustomEvent<ChangeKind>('change', { detail: kind }));
  }

  edit(kind: ChangeKind, fn: () => void) {
    this.checkpoint();
    fn();
    this.emit(kind);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (s === undefined) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    this.emit('pages');
  }

  redo() {
    const s = this.redoStack.pop();
    if (s === undefined) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    this.emit('pages');
  }

  /** Drops the latest undo entry without restoring it (used to fold no-op edits away). */
  discardCheckpoint() {
    this.undoStack.pop();
  }

  discardRedo() {
    this.redoStack.pop();
  }

  destroy() {
    for (const s of this.sources) s.doc.loadingTask.destroy();
    for (const img of this.images.values()) URL.revokeObjectURL(img.url);
    this.sources = [];
    this.pages = [];
    this.images.clear();
  }

  page(key: string) {
    return this.pages.find((p) => p.key === key);
  }

  findAnnot(id: string): { page: PageItem; annot: Annot } | null {
    for (const page of this.pages) {
      const annot = page.annots.find((a) => a.id === id);
      if (annot) return { page, annot };
    }
    return null;
  }

  /** Adds annotations with author/date filled in. Call inside edit(). */
  addAnnots(page: PageItem, ...annots: Annot[]) {
    const now = new Date().toISOString();
    for (const a of annots) {
      a.author ??= authorName();
      a.date ??= now;
    }
    page.annots.push(...annots);
  }
}
