import { type FontName, stampLayout, stampSize, type StampAnnot } from './annots';
import type { HeaderFooter, Security, Watermark } from './model';
import { availableTools, native, pickFiles, type SignatureStatus } from './native';
import { type Settings, settings } from './settings';
import { type Placing, type Style } from './tools';
import { customDialog, h } from './ui';

type Opt = [string, string];
type FieldDef =
  | { section: string }
  | { note: string }
  | {
      key: string;
      label: string;
      type: 'text' | 'password' | 'number' | 'color' | 'checkbox' | 'select' | 'range';
      options?: Opt[];
      min?: number;
      max?: number;
      step?: number;
      placeholder?: string;
      wide?: boolean;
    };

type Values = Record<string, string | number | boolean>;

interface FormOptions {
  ok?: string;
  /** Extra buttons on the left; resolve with their id. */
  extra?: { id: string; label: string; danger?: boolean }[];
  validate?: (v: Values) => string | null;
  intro?: string | HTMLElement;
  wide?: boolean;
}

export type FormResult = { action: 'ok' | string; values: Values } | null;

/** Generic labelled form in a modal. */
export function formDialog(title: string, fields: FieldDef[], initial: Values, opts: FormOptions = {}): Promise<FormResult> {
  return new Promise((resolve) => {
    let settled = false;
    const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
    customDialog(
      (close) => {
        const finish = (r: FormResult) => {
          if (settled) return;
          if (r && r.action === 'ok' && opts.validate) {
            const err = opts.validate(r.values);
            if (err) {
              error.textContent = err;
              return;
            }
          }
          settled = true;
          close();
          resolve(r);
        };
        const read = (): Values => {
          const v: Values = {};
          for (const [k, el] of inputs) {
            if (el instanceof HTMLInputElement && el.type === 'checkbox') v[k] = el.checked;
            else if (el instanceof HTMLInputElement && (el.type === 'number' || el.type === 'range')) v[k] = parseFloat(el.value);
            else v[k] = el.value;
          }
          return v;
        };
        const grid = h('div', { class: 'form-grid' });
        for (const f of fields) {
          if ('section' in f) {
            grid.append(h('div', { class: 'form-section', textContent: f.section }));
            continue;
          }
          if ('note' in f) {
            grid.append(h('div', { class: 'form-note', textContent: f.note }));
            continue;
          }
          let el: HTMLInputElement | HTMLSelectElement;
          if (f.type === 'select') {
            el = h('select', {}, ...(f.options ?? []).map(([v, l]) => h('option', { value: v, textContent: l })));
            el.value = String(initial[f.key] ?? '');
          } else {
            el = h('input', { type: f.type, placeholder: f.placeholder ?? '' });
            if (f.type === 'checkbox') el.checked = !!initial[f.key];
            else el.value = String(initial[f.key] ?? '');
            if (f.min !== undefined) el.min = String(f.min);
            if (f.max !== undefined) el.max = String(f.max);
            if (f.step !== undefined) el.step = String(f.step);
          }
          el.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') finish({ action: 'ok', values: read() });
          });
          inputs.set(f.key, el);
          if (f.type === 'checkbox') grid.append(h('label', { class: 'form-check' }, el, f.label));
          else grid.append(h('label', { class: `form-label${f.wide ? ' wide' : ''}`, textContent: f.label }), el);
        }
        const error = h('div', { class: 'form-error' });
        const box = h(
          'div',
          { class: `modal form-modal${opts.wide ? ' wide' : ''}` },
          h('p', { class: 'modal-msg', textContent: title }),
          opts.intro ? (typeof opts.intro === 'string' ? h('p', { class: 'modal-detail', textContent: opts.intro }) : opts.intro) : null,
          grid,
          error,
          h(
            'div',
            { class: 'modal-actions' },
            ...(opts.extra ?? []).map((b) => h('button', { textContent: b.label, class: b.danger ? 'danger-btn' : '', onclick: () => finish({ action: b.id, values: read() }) })),
            h('div', { class: 'spacer' }),
            h('button', { textContent: 'Cancel', onclick: () => finish(null) }),
            h('button', { class: 'primary', textContent: opts.ok ?? 'OK', onclick: () => finish({ action: 'ok', values: read() }) }),
          ),
        );
        requestAnimationFrame(() => (box.querySelector('input:not([type=checkbox]), select') as HTMLElement | null)?.focus());
        return box;
      },
      () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    );
  });
}

const FONT_OPTS: Opt[] = [
  ['Helvetica', 'Sans (Helvetica)'],
  ['Times', 'Serif (Times)'],
  ['Courier', 'Mono (Courier)'],
];

export async function settingsDialog(style: Style): Promise<{ settings: Partial<Settings>; style: Partial<Style> } | null> {
  const langs = native && (await availableTools()).tesseract ? await native.ocrLangs().catch(() => []) : [];
  const langOpts: Opt[] = (langs.length ? langs : [settings.ocrLang]).map((l) => [l, l]);
  const r = await formDialog(
    'Preferences',
    [
      { section: 'General' },
      { key: 'author', label: 'Author name', type: 'text', placeholder: 'Shown on comments' },
      { key: 'theme', label: 'Theme', type: 'select', options: [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] },
      { key: 'defaultZoom', label: 'Default zoom', type: 'select', options: [['width', 'Fit width'], ['page', 'Fit page'], ['1', '100%']] },
      { key: 'layout', label: 'Page layout', type: 'select', options: [['continuous', 'Continuous'], ['facing', 'Two pages'], ['single', 'Single page']] },
      { key: 'rememberPosition', label: 'Reopen documents at the last viewed page', type: 'checkbox' },
      { key: 'nightPages', label: 'Night mode: show pages with inverted colours', type: 'checkbox' },
      { section: 'Saving' },
      { key: 'saveMode', label: 'Annotations', type: 'select', options: [['annotations', 'Keep editable (PDF annotations)'], ['flatten', 'Flatten into page content']] },
      { section: 'Measuring & layout aids' },
      { key: 'units', label: 'Units', type: 'select', options: [['mm', 'Millimetres'], ['in', 'Inches'], ['pt', 'Points']] },
      { key: 'gridSize', label: 'Grid spacing (units)', type: 'number', min: 1, max: 200, step: 1 },
      { key: 'snap', label: 'Snap to guides, objects and grid (hold Alt to bypass)', type: 'checkbox' },
      { key: 'grid', label: 'Show grid', type: 'checkbox' },
      { key: 'rulers', label: 'Show rulers', type: 'checkbox' },
      { section: 'Text recognition' },
      { key: 'ocrLang', label: 'OCR language', type: 'select', options: langOpts },
      { section: 'Default annotation style' },
      { key: 'textColor', label: 'Text colour', type: 'color' },
      { key: 'font', label: 'Text font', type: 'select', options: FONT_OPTS },
      { key: 'fontSize', label: 'Text size (pt)', type: 'number', min: 4, max: 144 },
      { key: 'inkColor', label: 'Pen colour', type: 'color' },
      { key: 'inkWidth', label: 'Pen width (pt)', type: 'number', min: 0.5, max: 30, step: 0.5 },
      { key: 'shapeColor', label: 'Shape colour', type: 'color' },
      { key: 'markColor', label: 'Highlight colour', type: 'color' },
      { key: 'noteColor', label: 'Comment colour', type: 'color' },
    ],
    { ...settings, ...style, author: settings.author || (native ? await native.userName() : '') } as unknown as Values,
    { ok: 'Save', wide: true },
  );
  if (!r) return null;
  const v = r.values;
  return {
    settings: {
      author: String(v.author),
      theme: v.theme as Settings['theme'],
      defaultZoom: v.defaultZoom as Settings['defaultZoom'],
      layout: v.layout as Settings['layout'],
      rememberPosition: !!v.rememberPosition,
      nightPages: !!v.nightPages,
      saveMode: v.saveMode as Settings['saveMode'],
      units: v.units as Settings['units'],
      gridSize: Math.max(1, Number(v.gridSize) || 10),
      snap: !!v.snap,
      grid: !!v.grid,
      rulers: !!v.rulers,
      ocrLang: String(v.ocrLang),
    },
    style: {
      textColor: String(v.textColor),
      font: v.font as FontName,
      fontSize: Number(v.fontSize) || 14,
      inkColor: String(v.inkColor),
      inkWidth: Number(v.inkWidth) || 2,
      shapeColor: String(v.shapeColor),
      markColor: String(v.markColor),
      noteColor: String(v.noteColor),
    },
  };
}

export async function headerFooterDialog(cur: HeaderFooter | null): Promise<HeaderFooter | null | 'remove'> {
  const init: HeaderFooter = cur ?? { header: ['', '', ''], footer: ['', 'Page {page} of {pages}', ''], size: 9, margin: 28, color: '#444444', font: 'Helvetica', start: 1, skipFirst: false };
  const r = await formDialog(
    'Header & Footer',
    [
      { note: 'Tokens: {page}, {pages}, {date}, {file}' },
      { section: 'Header' },
      { key: 'h0', label: 'Left', type: 'text' },
      { key: 'h1', label: 'Center', type: 'text' },
      { key: 'h2', label: 'Right', type: 'text' },
      { section: 'Footer' },
      { key: 'f0', label: 'Left', type: 'text' },
      { key: 'f1', label: 'Center', type: 'text' },
      { key: 'f2', label: 'Right', type: 'text' },
      { section: 'Appearance' },
      { key: 'font', label: 'Font', type: 'select', options: FONT_OPTS },
      { key: 'size', label: 'Size (pt)', type: 'number', min: 4, max: 72 },
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'margin', label: 'Margin (pt)', type: 'number', min: 0, max: 200 },
      { key: 'start', label: 'First page number', type: 'number', min: 0, max: 99999 },
      { key: 'skipFirst', label: 'Skip the first page', type: 'checkbox' },
    ],
    { h0: init.header[0], h1: init.header[1], h2: init.header[2], f0: init.footer[0], f1: init.footer[1], f2: init.footer[2], font: init.font, size: init.size, color: init.color, margin: init.margin, start: init.start, skipFirst: init.skipFirst },
    { ok: 'Apply', extra: cur ? [{ id: 'remove', label: 'Remove', danger: true }] : [] },
  );
  if (!r) return null;
  if (r.action === 'remove') return 'remove';
  const v = r.values;
  return {
    header: [String(v.h0), String(v.h1), String(v.h2)],
    footer: [String(v.f0), String(v.f1), String(v.f2)],
    font: v.font as FontName,
    size: Number(v.size) || 9,
    color: String(v.color),
    margin: Number(v.margin) || 0,
    start: Number.isFinite(Number(v.start)) ? Number(v.start) : 1,
    skipFirst: !!v.skipFirst,
  };
}

export async function watermarkDialog(cur: Watermark | null): Promise<Watermark | null | 'remove'> {
  const init: Watermark = cur ?? { text: 'CONFIDENTIAL', size: 72, color: '#d11a2a', opacity: 0.15, angle: 45, font: 'Helvetica' };
  const r = await formDialog(
    'Watermark',
    [
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'font', label: 'Font', type: 'select', options: FONT_OPTS },
      { key: 'size', label: 'Size (pt)', type: 'number', min: 8, max: 300 },
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'opacity', label: 'Opacity (%)', type: 'range', min: 5, max: 100, step: 5 },
      { key: 'angle', label: 'Angle (°)', type: 'number', min: -90, max: 90 },
    ],
    { ...init, opacity: Math.round(init.opacity * 100) } as unknown as Values,
    { ok: 'Apply', extra: cur ? [{ id: 'remove', label: 'Remove', danger: true }] : [] },
  );
  if (!r) return null;
  if (r.action === 'remove') return 'remove';
  const v = r.values;
  return { text: String(v.text), font: v.font as FontName, size: Number(v.size) || 72, color: String(v.color), opacity: Number(v.opacity) / 100, angle: Number(v.angle) || 0 };
}

export async function protectDialog(cur: Security | null): Promise<Security | null | 'remove'> {
  const init = cur ?? { userPassword: '', ownerPassword: '', print: true, modify: false, copy: true, annotate: true };
  const r = await formDialog(
    'Protect with Password',
    [
      { section: 'Opening the document' },
      { key: 'user', label: 'Open password', type: 'password', placeholder: 'Leave empty for no password' },
      { key: 'user2', label: 'Confirm', type: 'password' },
      { section: 'Permissions' },
      { key: 'owner', label: 'Permissions password', type: 'password', placeholder: 'Needed to change restrictions' },
      { key: 'print', label: 'Allow printing', type: 'checkbox' },
      { key: 'modify', label: 'Allow editing', type: 'checkbox' },
      { key: 'copy', label: 'Allow copying text and images', type: 'checkbox' },
      { key: 'annotate', label: 'Allow comments and form filling', type: 'checkbox' },
      { note: 'Encryption uses AES-256 and is applied every time the document is saved.' },
    ],
    { user: init.userPassword, user2: init.userPassword, owner: init.ownerPassword, print: init.print, modify: init.modify, copy: init.copy, annotate: init.annotate },
    {
      ok: 'Apply',
      extra: cur ? [{ id: 'remove', label: 'Remove protection', danger: true }] : [],
      validate: (v) => {
        if (v.user !== v.user2) return 'The open passwords do not match.';
        if (!v.user && !v.owner) return 'Set an open password, a permissions password, or both.';
        if (v.owner && v.owner === v.user) return 'Use a different password for permissions.';
        return null;
      },
    },
  );
  if (!r) return null;
  if (r.action === 'remove') return 'remove';
  const v = r.values;
  return { userPassword: String(v.user), ownerPassword: String(v.owner), print: !!v.print, modify: !!v.modify, copy: !!v.copy, annotate: !!v.annotate };
}

export async function compressDialog(size: number): Promise<string | null> {
  const tools = await availableTools();
  const options: Opt[] = [];
  if (tools.qpdf) options.push(['lossless', 'Lossless — recompress structure only']);
  if (tools.gs) options.push(['printer', 'High quality — images at 300 dpi'], ['ebook', 'Balanced — images at 150 dpi'], ['screen', 'Smallest — images at 72 dpi']);
  if (!options.length) {
    await formDialog('Reduce File Size', [{ note: 'This needs qpdf and/or ghostscript: pacman -S qpdf ghostscript' }], {}, { ok: 'Close' });
    return null;
  }
  const r = await formDialog(
    'Reduce File Size',
    [
      { key: 'mode', label: 'Method', type: 'select', options },
      { note: `Current size: ${(size / 1024 / 1024).toFixed(2)} MB. Image downsampling can flatten form fields.` },
    ],
    { mode: tools.gs ? 'ebook' : 'lossless' },
    { ok: 'Reduce…' },
  );
  return r ? String(r.values.mode) : null;
}

export type SplitSpec = { mode: 'every'; n: number } | { mode: 'ranges'; ranges: number[][] } | { mode: 'bookmarks' };

export function parseRanges(s: string, total: number): number[][] | null {
  const groups: number[][] = [];
  for (const part of s.split(/[,;]/)) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*(?:-\s*(\d+|end))?$/i.exec(t);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = m[2] ? (/end/i.test(m[2]) ? total : parseInt(m[2], 10)) : a;
    if (a < 1 || b > total || a > b) return null;
    groups.push(Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
  }
  return groups.length ? groups : null;
}

export async function splitDialog(total: number, hasBookmarks: boolean): Promise<SplitSpec | null> {
  const modes: Opt[] = [
    ['every', 'Every N pages'],
    ['ranges', 'Page ranges'],
  ];
  if (hasBookmarks) modes.push(['bookmarks', 'Top-level bookmarks']);
  const r = await formDialog(
    'Split Document',
    [
      { key: 'mode', label: 'Split by', type: 'select', options: modes },
      { key: 'n', label: 'Pages per file', type: 'number', min: 1, max: total },
      { key: 'ranges', label: 'Ranges', type: 'text', placeholder: 'e.g. 1-3, 4-10, 11-end' },
      { note: `The document has ${total} pages. Each part is saved as a separate PDF.` },
    ],
    { mode: 'every', n: 1, ranges: '' },
    {
      ok: 'Split…',
      validate: (v) => (v.mode === 'ranges' && !parseRanges(String(v.ranges), total) ? 'Enter ranges like 1-3, 4-10, 11-end.' : null),
    },
  );
  if (!r) return null;
  const v = r.values;
  if (v.mode === 'ranges') return { mode: 'ranges', ranges: parseRanges(String(v.ranges), total)! };
  if (v.mode === 'bookmarks') return { mode: 'bookmarks' };
  return { mode: 'every', n: Math.max(1, Number(v.n) || 1) };
}

export async function ocrDialog(hasSelection: boolean): Promise<{ lang: string; scope: string; skipText: boolean } | null> {
  if (!native) {
    await formDialog('Recognize Text', [{ note: 'OCR is available in the desktop app (uses Tesseract).' }], {}, { ok: 'Close' });
    return null;
  }
  if (!(await availableTools()).tesseract) {
    await formDialog('Recognize Text', [{ note: 'Install Tesseract and a language pack: pacman -S tesseract tesseract-data-eng' }], {}, { ok: 'Close' });
    return null;
  }
  const langs = await native.ocrLangs();
  if (!langs.length) {
    await formDialog('Recognize Text', [{ note: 'No Tesseract language data found. Install one, e.g. pacman -S tesseract-data-eng' }], {}, { ok: 'Close' });
    return null;
  }
  const scopes: Opt[] = [
    ['all', 'All pages'],
    ['current', 'Current page'],
  ];
  if (hasSelection) scopes.push(['selected', 'Selected pages']);
  const r = await formDialog(
    'Recognize Text (OCR)',
    [
      { key: 'lang', label: 'Language', type: 'select', options: langs.map((l) => [l, l]) },
      { key: 'scope', label: 'Pages', type: 'select', options: scopes },
      { key: 'skipText', label: 'Skip pages that already contain text', type: 'checkbox' },
      { note: 'Adds an invisible text layer so scanned pages become searchable and selectable.' },
    ],
    { lang: langs.includes(settings.ocrLang) ? settings.ocrLang : langs[0], scope: hasSelection ? 'selected' : 'all', skipText: true },
    { ok: 'Recognize' },
  );
  return r ? { lang: String(r.values.lang), scope: String(r.values.scope), skipText: !!r.values.skipText } : null;
}

export interface DigitalSignSettings {
  p12Path: string;
  password: string;
  name: string;
  reason: string;
  location: string;
  contact: string;
}

const ID_KEY = 'digitalIds';
const knownIds = (): string[] => JSON.parse(localStorage.getItem(ID_KEY) ?? '[]');
const rememberId = (p: string) => localStorage.setItem(ID_KEY, JSON.stringify([p, ...knownIds().filter((x) => x !== p)].slice(0, 8)));

async function createIdDialog(): Promise<string | null> {
  const r = await formDialog(
    'Create Digital ID',
    [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'org', label: 'Organization', type: 'text' },
      { key: 'password', label: 'Password', type: 'password' },
      { key: 'password2', label: 'Confirm', type: 'password' },
      { note: 'Creates a self-signed certificate (.p12). Recipients will see the signature as valid but the identity as not verified by a certificate authority.' },
    ],
    { name: settings.author || (native ? await native.userName() : ''), email: '', org: '', password: '', password2: '' },
    { ok: 'Create…', validate: (v) => (!String(v.name).trim() ? 'A name is required.' : String(v.password).length < 6 ? 'Use at least 6 characters.' : v.password !== v.password2 ? 'Passwords do not match.' : null) },
  );
  if (!r) return null;
  const path = await native!.createDigitalId({ name: String(r.values.name), email: String(r.values.email), org: String(r.values.org), password: String(r.values.password) });
  if (path) rememberId(path);
  return path;
}

export async function digitalSignDialog(): Promise<DigitalSignSettings | null> {
  if (!native) {
    await formDialog('Sign with Certificate', [{ note: 'Certificate signatures are available in the desktop app.' }], {}, { ok: 'Close' });
    return null;
  }
  for (;;) {
    const ids = knownIds();
    const r = await formDialog(
      'Sign with Certificate',
      [
        { key: 'id', label: 'Digital ID', type: 'select', options: [...ids.map((p): Opt => [p, p.split('/').pop()!]), ['__browse', 'Browse for .p12/.pfx…']] },
        { key: 'password', label: 'ID password', type: 'password' },
        { key: 'name', label: 'Name shown', type: 'text' },
        { key: 'reason', label: 'Reason', type: 'text', placeholder: 'e.g. I approve this document' },
        { key: 'location', label: 'Location', type: 'text' },
        { key: 'contact', label: 'Contact', type: 'text' },
        { note: 'Next, drag a rectangle where the signature should appear. The document is then saved as a new signed file; any later change invalidates the signature.' },
      ],
      { id: ids[0] ?? '__browse', password: '', name: settings.author || (await native.userName()), reason: '', location: '', contact: '' },
      { ok: 'Continue', extra: [{ id: 'create', label: 'Create new ID…' }] },
    );
    if (!r) return null;
    if (r.action === 'create') {
      await createIdDialog();
      continue;
    }
    let p12 = String(r.values.id);
    if (p12 === '__browse') {
      const picked = await native.pickDigitalId();
      if (!picked) continue;
      rememberId(picked);
      p12 = picked;
      if (!r.values.password) continue;
    }
    return { p12Path: p12, password: String(r.values.password), name: String(r.values.name), reason: String(r.values.reason), location: String(r.values.location), contact: String(r.values.contact) };
  }
}

export function signaturesDialog(list: SignatureStatus[]) {
  return formDialog(
    'Digital Signatures',
    list.length
      ? list.flatMap((s): FieldDef[] => [
          { section: `${s.field}: ${s.signer}` },
          {
            note: s.error
              ? `Could not be checked: ${s.error}`
              : `${s.intact ? '✔ Signature is valid — the signed content has not been changed.' : '✖ INVALID — the document was altered after signing or the signature is corrupt.'}${s.intact && !s.coversWholeFile ? ' The document has changes added after this signature.' : ''}${s.selfSigned ? ' Identity is self-signed (not verified by a certificate authority).' : ''}`,
          },
          { note: [s.date && `Signed ${new Date(s.date).toLocaleString()}`, s.reason && `Reason: ${s.reason}`, s.location && `Location: ${s.location}`].filter(Boolean).join(' · ') || ' ' },
        ])
      : [{ note: 'This document has no digital signatures.' }],
    {},
    { ok: 'Close' },
  );
}

const PRESETS: { label: string; color: string; dynamic?: boolean }[] = [
  { label: 'APPROVED', color: '#15803d' },
  { label: 'REJECTED', color: '#b91c1c' },
  { label: 'DRAFT', color: '#1d4ed8' },
  { label: 'FINAL', color: '#15803d' },
  { label: 'CONFIDENTIAL', color: '#b91c1c' },
  { label: 'FOR REVIEW', color: '#c2410c' },
  { label: 'COMPLETED', color: '#15803d' },
  { label: 'VOID', color: '#b91c1c' },
  { label: 'APPROVED', color: '#15803d', dynamic: true },
  { label: 'RECEIVED', color: '#1d4ed8', dynamic: true },
  { label: 'REVIEWED', color: '#7c3aed', dynamic: true },
];

const CUSTOM_KEY = 'customStamps';

function stampPreview(label: string, sub: string | undefined, color: string) {
  const { w, h: hh } = stampSize(label, sub, 30);
  const a: StampAnnot = { id: '', type: 'stamp', x: 0, y: 0, w, h: hh, label, sub, rot: 0, color };
  const L = stampLayout(a);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-w / 2 - 2} ${-hh / 2 - 2} ${w + 4} ${hh + 4}" width="${w + 4}" height="${hh + 4}"><rect x="${-L.sw / 2 + L.border / 2}" y="${-L.sh / 2 + L.border / 2}" width="${L.sw - L.border}" height="${L.sh - L.border}" rx="${L.radius}" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="${L.border}"/><text text-anchor="middle" y="${L.labelY}" font-size="${L.labelSize}" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="${color}">${esc(label)}</text>${sub ? `<text text-anchor="middle" y="${L.subY}" font-size="${L.subSize}" font-weight="bold" font-family="Helvetica, Arial, sans-serif" fill="${color}">${esc(sub)}</text>` : ''}</svg>`;
  const wrap = h('span', { class: 'stamp-preview' });
  wrap.innerHTML = svg;
  return wrap;
}

export function dynamicSub(author: string) {
  return `${author} · ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/** Stamp palette; resolves to what to place. */
export function stampDialog(author: string): Promise<Placing | 'image' | null> {
  return new Promise((resolve) => {
    let settled = false;
    customDialog(
      (close) => {
        const done = (v: Placing | 'image' | null) => {
          if (settled) return;
          settled = true;
          close();
          resolve(v);
        };
        const custom: { label: string; color: string }[] = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]');
        const tile = (label: string, color: string, sub?: string, onDelete?: () => void) => {
          const b = h('button', { class: 'stamp-tile', title: sub ? `${label} with name and date` : label, onclick: () => done({ kind: 'stamp', label, sub, color }) }, stampPreview(label, sub, color));
          if (onDelete) {
            const x = h('span', { class: 'sig-del', textContent: '×', title: 'Remove' });
            x.onclick = (e) => {
              e.stopPropagation();
              onDelete();
              b.remove();
            };
            b.append(x);
          }
          return b;
        };
        const label = h('input', { placeholder: 'Custom stamp text', class: 'grow' });
        const color = h('input', { type: 'color', value: '#1d4ed8' });
        const withDate = h('input', { type: 'checkbox' });
        const make = () => {
          const t = label.value.trim().toUpperCase();
          if (!t) return;
          localStorage.setItem(CUSTOM_KEY, JSON.stringify([{ label: t, color: color.value }, ...custom.filter((c) => c.label !== t)].slice(0, 12)));
          done({ kind: 'stamp', label: t, sub: withDate.checked ? dynamicSub(author) : undefined, color: color.value });
        };
        label.addEventListener('keydown', (e) => e.key === 'Enter' && make());
        return h(
          'div',
          { class: 'modal stamp-modal' },
          h('p', { class: 'modal-msg', textContent: 'Stamps' }),
          h('div', { class: 'stamp-grid' }, ...PRESETS.map((p) => tile(p.label, p.color, p.dynamic ? dynamicSub(author) : undefined))),
          custom.length
            ? h(
                'div',
                {},
                h('p', { class: 'modal-detail', textContent: 'Custom' }),
                h(
                  'div',
                  { class: 'stamp-grid' },
                  ...custom.map((c) =>
                    tile(c.label, c.color, undefined, () =>
                      localStorage.setItem(CUSTOM_KEY, JSON.stringify((JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as { label: string }[]).filter((x) => x.label !== c.label))),
                    ),
                  ),
                ),
              )
            : null,
          h('div', { class: 'stamp-custom' }, label, color, h('label', { class: 'check' }, withDate, 'Name & date'), h('button', { textContent: 'Create', onclick: make })),
          h(
            'div',
            { class: 'modal-actions' },
            h('button', { textContent: 'Image stamp…', onclick: () => done('image') }),
            h('div', { class: 'spacer' }),
            h('button', { textContent: 'Cancel', onclick: () => done(null) }),
          ),
        );
      },
      () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      },
    );
  });
}

export async function pickImageFile() {
  const [f] = await pickFiles('image/*', false);
  return f ?? null;
}

export async function redactConfirmDialog(count: number): Promise<{ sanitize: boolean } | null> {
  const r = await formDialog(
    'Apply Redactions',
    [
      { note: `${count} page${count > 1 ? 's' : ''} will be permanently redacted. Marked content is removed from the file: those pages are converted to images, and text outside the marks is kept as searchable text.` },
      { key: 'sanitize', label: 'Also remove document metadata (title, author, XMP)', type: 'checkbox' },
      { note: 'You can still undo before saving.' },
    ],
    { sanitize: true },
    { ok: 'Apply' },
  );
  return r ? { sanitize: !!r.values.sanitize } : null;
}
