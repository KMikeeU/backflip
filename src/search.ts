import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import type { DocModel } from './model';

export interface PageText {
  content: TextContent;
  /** Normalised page text: item strings joined, line ends as spaces. Item i starts at starts[i]. */
  text: string;
  starts: number[];
}

export interface Match {
  pageKey: string;
  start: number;
  end: number;
}

export class TextIndex {
  private cache = new Map<string, Promise<PageText>>();
  constructor(private model: DocModel) {}

  get(src: number, index: number): Promise<PageText> | null {
    if (src < 0) return null;
    const k = `${src}:${index}`;
    let p = this.cache.get(k);
    if (!p) {
      p = (async () => {
        const page = await this.model.sources[src].doc.getPage(index + 1);
        const content = await page.getTextContent();
        let text = '';
        const starts: number[] = [];
        for (const it of content.items) {
          if (!('str' in it)) continue;
          const item = it as TextItem;
          starts.push(text.length);
          text += item.str.replace(/\s/g, ' ');
          if (item.hasEOL) text += ' ';
        }
        return { content, text, starts };
      })();
      this.cache.set(k, p);
    }
    return p;
  }

  clear() {
    this.cache.clear();
  }
}

export class Search extends EventTarget {
  query = '';
  caseSensitive = false;
  matches: Match[] = [];
  current = -1;
  running = false;
  private byPage = new Map<string, number[]>();
  private token = 0;

  constructor(
    private model: DocModel,
    private index: TextIndex,
  ) {
    super();
  }

  private emit() {
    this.dispatchEvent(new Event('change'));
  }

  async run(query: string, caseSensitive = this.caseSensitive) {
    const token = ++this.token;
    this.query = query;
    this.caseSensitive = caseSensitive;
    this.matches = [];
    this.byPage.clear();
    this.current = -1;
    const needle = caseSensitive ? query.replace(/\s+/g, ' ') : query.replace(/\s+/g, ' ').toLowerCase();
    if (!needle.trim()) {
      this.running = false;
      this.emit();
      return;
    }
    this.running = true;
    this.emit();
    for (const page of this.model.pages) {
      const pt = await this.index.get(page.src, page.index);
      if (token !== this.token) return;
      if (!pt) continue;
      const hay = caseSensitive ? pt.text : pt.text.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        const list = this.byPage.get(page.key) ?? [];
        list.push(this.matches.length);
        this.byPage.set(page.key, list);
        this.matches.push({ pageKey: page.key, start: i, end: i + needle.length });
        if (this.current === -1) this.current = 0;
        i = hay.indexOf(needle, i + needle.length);
      }
      // Emit progressively so the first hits show while big documents are still being scanned.
      if (this.matches.length && this.matches.length < 50) this.emit();
    }
    this.running = false;
    this.emit();
  }

  clear() {
    this.token++;
    this.query = '';
    this.matches = [];
    this.byPage.clear();
    this.current = -1;
    this.running = false;
    this.emit();
  }

  step(dir: 1 | -1) {
    if (!this.matches.length) return;
    this.current = (this.current + dir + this.matches.length) % this.matches.length;
    this.emit();
  }

  /** Wraps matched substrings of the rendered text layer in highlight spans. */
  decorate(pageKey: string, pt: PageText, divs: HTMLElement[], strs: string[]) {
    for (let i = 0; i < divs.length; i++) {
      if (divs[i].dataset.hl) {
        divs[i].textContent = strs[i];
        delete divs[i].dataset.hl;
      }
    }
    const ids = this.byPage.get(pageKey);
    if (!ids) return null;
    let currentEl: HTMLElement | null = null;
    const perDiv = new Map<number, { s: number; e: number; cur: boolean }[]>();
    for (const mi of ids) {
      const m = this.matches[mi];
      for (let i = 0; i < pt.starts.length && i < divs.length; i++) {
        const st = pt.starts[i];
        const en = st + strs[i].length;
        if (en <= m.start || st >= m.end) continue;
        const list = perDiv.get(i) ?? [];
        list.push({ s: Math.max(m.start, st) - st, e: Math.min(m.end, en) - st, cur: mi === this.current });
        perDiv.set(i, list);
      }
    }
    for (const [i, ranges] of perDiv) {
      const div = divs[i];
      const s = strs[i];
      div.dataset.hl = '1';
      div.textContent = '';
      let pos = 0;
      for (const r of ranges.sort((a, b) => a.s - b.s)) {
        if (r.s < pos) continue;
        if (r.s > pos) div.append(s.slice(pos, r.s));
        const span = document.createElement('span');
        span.className = r.cur ? 'search-hl current' : 'search-hl';
        span.textContent = s.slice(r.s, r.e);
        div.append(span);
        if (r.cur && !currentEl) currentEl = span;
        pos = r.e;
      }
      if (pos < s.length) div.append(s.slice(pos));
    }
    return currentEl;
  }
}
