import 'pdfjs-dist/web/pdf_viewer.css';
import './style.css';
import {
  ArrowRight,
  CaseSensitive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Copy,
  Ellipsis,
  Eraser,
  EyeOff,
  FileOutput,
  FilePlus,
  FileText,
  FolderOpen,
  Hand,
  Highlighter,
  type IconNode,
  ImagePlus,
  MessageSquare,
  MessageSquarePlus,
  Minus,
  Monitor,
  Moon,
  MousePointer2,
  PanelLeft,
  Pencil,
  PenLine,
  Plus,
  Printer,
  Redo2,
  RotateCcw,
  RotateCw,
  Ruler,
  Save,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Signature,
  Square,
  Stamp,
  Strikethrough,
  Sun,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  Eclipse,
  ScanText,
  Heading,
  Droplets,
  Shrink,
  FileLock,
  Scissors,
  FileKey,
  ShieldCheck,
  Presentation,
} from 'lucide';
import type { Annot, FieldKind } from './annots';
import { headerFooterDialog, pickImageFile, protectDialog, settingsDialog, splitDialog, stampDialog, watermarkDialog } from './dialogs';
import { fromFile, native, type OpenedFile, openDialog } from './native';
import { makeImageAsset } from './pdf';
import { Rulers } from './rulers';
import { recentFiles, Session } from './session';
import { authorName, type Layout, settings, settingsEvents, type Theme, updateSettings } from './settings';
import { signatureDialog } from './signature';
import { colorKey, type Style, type Tool } from './tools';
import { choiceDialog, contextMenu, h, icon, iconButton, toast } from './ui';

const APP = 'PDF Editor';
const sessions: Session[] = [];
let S: Session;

// ------------------------------------------------------------------ theme

const THEMES: Record<Theme, { icon: IconNode; label: string }> = {
  system: { icon: Monitor, label: 'System' },
  light: { icon: Sun, label: 'Light' },
  dark: { icon: Moon, label: 'Dark' },
};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const themeBtn = h('button', { class: 'icon-btn' });

function applyTheme() {
  const theme = THEMES[settings.theme] ? settings.theme : 'system';
  // Native menus, dialogs and the system preference query follow nativeTheme in Electron.
  native?.setTheme(theme);
  document.documentElement.dataset.theme = theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  themeBtn.replaceChildren(icon(THEMES[theme].icon));
  themeBtn.title = `Theme: ${THEMES[theme].label} (click to change)`;
}
themeBtn.onclick = () => {
  const order: Theme[] = ['system', 'light', 'dark'];
  updateSettings({ theme: order[(order.indexOf(settings.theme) + 1) % order.length] });
};
darkQuery.addEventListener('change', () => settings.theme === 'system' && applyTheme());

// ------------------------------------------------------------------ layout

const pageInput = h('input', { class: 'page-input', type: 'text', value: '1' });
const pageCount = h('span', { class: 'page-count', textContent: '/ 0' });
const zoomSelect = h('select', { class: 'zoom-select', title: 'Zoom' });
const layoutSelect = h(
  'select',
  { class: 'layout-select', title: 'Page layout' },
  ...([
    ['continuous', 'Continuous'],
    ['facing', 'Two pages'],
    ['single', 'Single page'],
  ] as const).map(([v, l]) => h('option', { value: v, textContent: l })),
);
const undoBtn = iconButton(Undo2, 'Undo (Ctrl+Z)', () => run('undo'));
const redoBtn = iconButton(Redo2, 'Redo (Ctrl+Shift+Z)', () => run('redo'));
const saveBtn = iconButton(Save, 'Save (Ctrl+S)', () => run('save'));
const nightBtn = iconButton(Eclipse, 'Night mode pages', () => run('toggle-night'));

const toolbar = h(
  'header',
  { class: 'toolbar' },
  h(
    'div',
    { class: 'group' },
    iconButton(PanelLeft, 'Toggle sidebar (F4)', () => run('toggle-sidebar')),
    iconButton(FolderOpen, 'Open (Ctrl+O)', () => run('open')),
    saveBtn,
    iconButton(Printer, 'Print (Ctrl+P)', () => run('print')),
    h('div', { class: 'sep' }),
    undoBtn,
    redoBtn,
  ),
  h(
    'div',
    { class: 'group center doc-only' },
    iconButton(ChevronLeft, 'Previous page', () => S.viewer.scrollToPage(S.viewer.currentIndex - 1)),
    pageInput,
    pageCount,
    iconButton(ChevronRight, 'Next page', () => S.viewer.scrollToPage(S.viewer.currentIndex + 1)),
    h('div', { class: 'sep' }),
    iconButton(ZoomOut, 'Zoom out (Ctrl+-)', () => S.viewer.zoomStep(-1)),
    zoomSelect,
    iconButton(ZoomIn, 'Zoom in (Ctrl+=)', () => S.viewer.zoomStep(1)),
    layoutSelect,
    h('div', { class: 'sep' }),
    iconButton(RotateCcw, 'Rotate pages counterclockwise (Ctrl+[)', () => run('rotate-ccw')),
    iconButton(RotateCw, 'Rotate pages clockwise (Ctrl+])', () => run('rotate-cw')),
  ),
  h(
    'div',
    { class: 'group right' },
    h('span', { class: 'doc-only group' }, iconButton(FilePlus, 'Insert pages from file', () => run('insert-file')), iconButton(Ellipsis, 'More tools', (e) => moreMenu(e)), h('div', { class: 'sep' }), iconButton(SearchIcon, 'Find (Ctrl+F)', () => run('find'))),
    nightBtn,
    themeBtn,
    iconButton(SettingsIcon, 'Preferences (Ctrl+,)', () => run('settings')),
  ),
);

const tabbar = h('div', { class: 'tabbar' });

type RailTool = Tool | 'image' | 'signature' | 'stamp';
const TOOL_DEFS: ([RailTool, IconNode, string, string] | 'sep')[] = [
  ['select', MousePointer2, 'Select', 'V'],
  ['hand', Hand, 'Hand', 'H'],
  'sep',
  ['text', Type, 'Add text', 'T'],
  ['edittext', PenLine, 'Edit page text', 'E'],
  ['note', MessageSquare, 'Comment', 'N'],
  'sep',
  ['highlight', Highlighter, 'Highlight', 'U'],
  ['underline', Underline, 'Underline', ''],
  ['strike', Strikethrough, 'Strikethrough', ''],
  'sep',
  ['draw', Pencil, 'Draw', 'D'],
  ['rect', Square, 'Rectangle', 'R'],
  ['ellipse', Circle, 'Ellipse', 'O'],
  ['line', Minus, 'Line', 'L'],
  ['arrow', ArrowRight, 'Arrow', 'A'],
  ['measure', Ruler, 'Measure distance', 'M'],
  'sep',
  ['stamp', Stamp, 'Stamp', 'K'],
  ['image', ImagePlus, 'Image', 'I'],
  ['signature', Signature, 'Sign', 'S'],
  ['field', TextCursorInput, 'Form field', 'F'],
  'sep',
  ['whiteout', Eraser, 'Whiteout', 'W'],
  ['redact', EyeOff, 'Redact', 'X'],
];
const toolButtons = new Map<string, HTMLButtonElement>();
const toolrail = h(
  'nav',
  { class: 'toolrail doc-only' },
  ...TOOL_DEFS.map((d) => {
    if (d === 'sep') return h('div', { class: 'sep' });
    const [id, ic, label, key] = d;
    const b = iconButton(ic, key ? `${label} (${key})` : label, () => chooseTool(id));
    toolButtons.set(id, b);
    return b;
  }),
);

const propsbar = h('div', { class: 'propsbar' });
const findInput = h('input', { type: 'search', placeholder: 'Find in document', class: 'find-input' });
const findCount = h('span', { class: 'find-count' });
const caseBtn = iconButton(CaseSensitive, 'Match case', () => {
  caseBtn.classList.toggle('active');
  S.search.run(findInput.value, caseBtn.classList.contains('active'));
});
const findbar = h(
  'div',
  { class: 'findbar', hidden: true },
  icon(SearchIcon, 16),
  findInput,
  findCount,
  caseBtn,
  iconButton(ChevronUp, 'Previous (Shift+Enter)', () => S.search.step(-1)),
  iconButton(ChevronDown, 'Next (Enter)', () => S.search.step(1)),
  iconButton(X, 'Close (Esc)', () => closeFind()),
);

const recentList = h('div', { class: 'recent' });
const welcome = h(
  'div',
  { class: 'welcome' },
  h(
    'div',
    { class: 'welcome-card' },
    h('div', { class: 'welcome-icon' }, icon(FileText, 48)),
    h('h1', { textContent: APP }),
    h('p', { textContent: 'View, annotate, fill, sign and rearrange PDF documents.' }),
    h('button', { class: 'primary big', onclick: () => run('open') }, icon(FolderOpen), 'Open file…'),
    h('p', { class: 'hint', textContent: 'or drop PDFs / images anywhere in this window' }),
    recentList,
  ),
);

const viewerSlot = h('div', { class: 'viewer-slot' });
const sidebarSlot = h('div', { class: 'sidebar-slot' });
const main = h('main', { class: 'main' }, propsbar, findbar, viewerSlot, welcome);
const rulers = new Rulers(main);
const app = h('div', { class: 'app' }, toolbar, tabbar, h('div', { class: 'body' }, toolrail, sidebarSlot, main));
document.body.append(app, h('div', { id: 'print-root' }));

// ------------------------------------------------------------------ sessions & tabs

function newSession() {
  const s = new Session();
  sessions.push(s);
  s.addEventListener('change', () => {
    renderTabs();
    updateWindowState();
    if (s === S) updateChrome();
  });
  s.viewer.addEventListener('pagechange', () => s === S && updatePageNav());
  s.viewer.addEventListener('scalechange', () => s === S && updateZoom());
  s.tools.addEventListener('toolchange', () => s === S && (updateToolButtons(), updateProps()));
  s.tools.addEventListener('selectionchange', () => s === S && updateProps());
  s.search.addEventListener('change', () => s === S && updateFind());
  return s;
}

function activate(s: Session) {
  if (S && S !== s) {
    S.scroll = { top: S.container.scrollTop, left: S.container.scrollLeft };
    S.container.remove();
    S.sidebar.el.remove();
    S.tools.setTool('select');
  }
  S = s;
  viewerSlot.replaceChildren(s.container);
  sidebarSlot.replaceChildren(s.sidebar.el);
  s.container.scrollTop = s.scroll.top;
  s.container.scrollLeft = s.scroll.left;
  findbar.hidden = !s.search.query;
  findInput.value = s.search.query;
  lastRevealed = -1;
  rulers.attach(s.viewer);
  updateChrome();
  renderTabs();
}

async function closeSession(s: Session, force = false) {
  if (!force && s.model.dirty) {
    activate(s);
    const r = await choiceDialog(`Save changes to “${s.model.name}”?`, 'Your changes will be lost if you don’t save them.', ['Save', "Don't Save", 'Cancel']);
    if (r === -1 || r === 2) return false;
    if (r === 0 && !(await s.save(false))) return false;
  }
  const i = sessions.indexOf(s);
  sessions.splice(i, 1);
  const wasActive = s === S;
  s.destroy();
  if (!sessions.length) activate(newSession());
  else if (wasActive) activate(sessions[Math.min(i, sessions.length - 1)]);
  renderTabs();
  updateWindowState();
  return true;
}

function renderTabs() {
  const show = sessions.length > 1 || sessions.some((s) => s.model.loaded);
  tabbar.hidden = !show;
  tabbar.replaceChildren(
    ...sessions.map((s) => {
      const close = h('button', { class: 'tab-close', title: 'Close (Ctrl+W)', textContent: '×' });
      close.onclick = (e) => {
        e.stopPropagation();
        closeSession(s);
      };
      const t = h(
        'div',
        { class: `doc-tab${s === S ? ' active' : ''}${s.model.dirty ? ' dirty' : ''}`, title: s.model.path ?? s.title },
        h('span', { class: 'doc-tab-dot' }),
        h('span', { class: 'doc-tab-name', textContent: s.title }),
        close,
      );
      t.onclick = () => s !== S && activate(s);
      t.onauxclick = (e) => e.button === 1 && closeSession(s);
      return t;
    }),
    h('button', { class: 'tab-new', title: 'Open in new tab (Ctrl+O)', onclick: () => run('open') }, icon(Plus, 16)),
  );
}

function updateWindowState() {
  native?.setDirty(sessions.some((s) => s.model.dirty));
}

async function openFiles(files: OpenedFile[]) {
  if (!files.length) return;
  const target = S.model.loaded ? newSession() : S;
  activate(target);
  const ok = await target.open(files);
  if (!ok && !target.model.loaded && sessions.length > 1) await closeSession(target, true);
  if (ok) {
    target.container.focus();
    updateChrome();
  }
}

// ------------------------------------------------------------------ state → UI

function updateChrome() {
  const loaded = S.model.loaded;
  document.body.classList.toggle('no-doc', !loaded);
  const t = loaded ? `${S.model.dirty ? '• ' : ''}${S.model.name} — ${APP}` : APP;
  document.title = t;
  native?.setTitle(t);
  undoBtn.disabled = !S.model.canUndo;
  redoBtn.disabled = !S.model.canRedo;
  saveBtn.classList.toggle('attention', S.model.dirty);
  layoutSelect.value = S.viewer.layout;
  if (!loaded) renderRecent();
  updatePageNav();
  updateZoom();
  updateToolButtons();
  updateProps();
  rulers.schedule();
}

function updatePageNav() {
  pageInput.value = String(S.viewer.currentIndex + 1);
  pageCount.textContent = `/ ${S.model.pages.length}`;
  S.sidebar.setCurrent(S.viewer.currentIndex);
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
function updateZoom() {
  zoomSelect.replaceChildren(
    h('option', { value: 'current', textContent: `${Math.round(S.viewer.scale * 100)}%`, hidden: true }),
    h('option', { value: 'width', textContent: 'Fit width' }),
    h('option', { value: 'page', textContent: 'Fit page' }),
    ...ZOOMS.map((z) => h('option', { value: String(z), textContent: `${z * 100}%` })),
  );
  zoomSelect.value = 'current';
}

function updateToolButtons() {
  const t = S.tools.tool === 'place' && S.tools.placing?.kind === 'stamp' ? 'stamp' : S.tools.tool;
  for (const [id, b] of toolButtons) b.classList.toggle('active', id === t);
}

zoomSelect.onchange = () => {
  const v = zoomSelect.value;
  if (v === 'width' || v === 'page') S.viewer.fit(v);
  else if (v !== 'current') S.viewer.setScale(parseFloat(v));
  updateZoom();
};
layoutSelect.onchange = () => S.viewer.setLayout(layoutSelect.value as Layout);
pageInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    const n = parseInt(pageInput.value, 10);
    if (n >= 1) S.viewer.scrollToPage(n - 1);
    S.container.focus();
  }
});
pageInput.addEventListener('focus', () => pageInput.select());
pageInput.addEventListener('blur', updatePageNav);

// ------------------------------------------------------------------ properties bar

function swatchInput(key: keyof Style) {
  const input = h('input', { type: 'color', value: String(S.tools.style[key]).slice(0, 7), title: 'Colour' });
  input.addEventListener('input', () => S.tools.applyStyle({ [key]: input.value } as Partial<Style>));
  return input;
}

function selectInput<T extends string | number>(key: keyof Style, opts: [T, string][], title: string) {
  const s = h('select', { title }, ...opts.map(([v, l]) => h('option', { value: String(v), textContent: l })));
  s.value = String(S.tools.style[key]);
  s.onchange = () => S.tools.applyStyle({ [key]: typeof opts[0][0] === 'number' ? parseFloat(s.value) : s.value } as Partial<Style>);
  return s;
}

const hint = (text: string) => h('span', { class: 'hint', textContent: text });

function fieldControls(a: Annot & { type: 'field' }) {
  const name = h('input', { class: 'prop-input', value: a.name, title: 'Field name' });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  name.addEventListener('change', () => S.tools.updateSelection((x) => x.type === 'field' && (x.name = name.value.trim() || x.name)));
  const kind = h('select', { title: 'Field type' }, ...FIELD_KINDS.map(([v, l]) => h('option', { value: v, textContent: l })));
  kind.value = a.kind;
  kind.onchange = () => S.tools.updateSelection((x) => x.type === 'field' && (x.kind = kind.value as FieldKind));
  const parts: HTMLElement[] = [h('span', { class: 'hint', textContent: 'Name' }), name, kind];
  if (a.kind === 'dropdown' || a.kind === 'radio') {
    const opts = h('input', { class: 'prop-input wide', value: a.options.join(', '), title: a.kind === 'radio' ? 'Export value of this button' : 'Options, comma-separated' });
    opts.addEventListener('keydown', (e) => e.stopPropagation());
    opts.addEventListener('change', () =>
      S.tools.updateSelection((x) => x.type === 'field' && (x.options = opts.value.split(',').map((o) => o.trim()).filter(Boolean))),
    );
    parts.push(h('span', { class: 'hint', textContent: a.kind === 'radio' ? 'Value' : 'Options' }), opts);
  }
  if (a.kind === 'text' || a.kind === 'multiline' || a.kind === 'dropdown')
    parts.push(selectInput('fontSize', [8, 9, 10, 11, 12, 14, 16, 18, 24].map((n) => [n, `${n} pt`] as [number, string]), 'Font size'));
  return parts;
}

const FIELD_KINDS: [FieldKind, string][] = [
  ['text', 'Text'],
  ['multiline', 'Multi-line text'],
  ['checkbox', 'Checkbox'],
  ['radio', 'Radio button'],
  ['dropdown', 'Dropdown'],
];

function updateProps() {
  if (!S) return;
  const tools = S.tools;
  const sel = tools.selection;
  const subject: string = sel.length ? sel[0].type : tools.tool;
  if (sel.length === 1) {
    const a = sel[0];
    const ck = colorKey(a.type);
    if (ck) (tools.style as unknown as Record<string, unknown>)[ck] = a.color.slice(0, 7);
    if (a.type === 'text') Object.assign(tools.style, { fontSize: a.size, font: a.font });
    if (a.type === 'ink') Object.assign(tools.style, { inkWidth: a.width, inkOpacity: a.opacity });
    if (a.type === 'rect' || a.type === 'ellipse') Object.assign(tools.style, { shapeWidth: a.width, fill: !!a.fill });
    if (a.type === 'line') tools.style.shapeWidth = a.width;
  }
  const parts: HTMLElement[] = [];
  const ck = colorKey(subject as Tool);
  if (ck && !(sel[0]?.type === 'line' && sel[0].measure)) parts.push(swatchInput(ck));
  if (subject === 'text') {
    parts.push(
      selectInput('font', [['Helvetica', 'Sans'], ['Times', 'Serif'], ['Courier', 'Mono']], 'Font'),
      selectInput('fontSize', [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72].map((n) => [n, `${n} pt`] as [number, string]), 'Font size'),
    );
  }
  if (subject === 'draw' || subject === 'ink') {
    parts.push(
      selectInput('inkWidth', [1, 2, 3, 4, 6, 8, 12, 16].map((n) => [n, `${n} pt`] as [number, string]), 'Stroke width'),
      selectInput('inkOpacity', [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.3, '30%']], 'Opacity'),
    );
  }
  if (['rect', 'ellipse', 'line', 'arrow'].includes(subject) && !(sel[0]?.type === 'line' && sel[0].measure)) {
    parts.push(selectInput('shapeWidth', [0.5, 1, 2, 3, 4, 6, 8].map((n) => [n, `${n} pt`] as [number, string]), 'Stroke width'));
    if (subject === 'rect' || subject === 'ellipse') {
      const cb = h('input', { type: 'checkbox', checked: tools.style.fill });
      cb.onchange = () => tools.applyStyle({ fill: cb.checked });
      parts.push(h('label', { class: 'check' }, cb, 'Fill'));
    }
  }
  if (subject === 'measure' || (sel[0]?.type === 'line' && sel[0].measure)) {
    const units = h('select', { title: 'Units' }, ...(['mm', 'in', 'pt'] as const).map((u) => h('option', { value: u, textContent: u })));
    units.value = settings.units;
    units.onchange = () => updateSettings({ units: units.value as 'mm' });
    parts.push(units);
    if (!sel.length) parts.push(hint('Drag to measure · Shift snaps to 45°'));
  }
  if (sel.length === 1 && sel[0].type === 'field') parts.push(...fieldControls(sel[0]));
  else if (tools.tool === 'field') {
    const kind = selectInput('fieldKind', FIELD_KINDS, 'Field type');
    parts.push(kind, hint('Drag to create a form field'));
  }
  if (tools.tool === 'edittext') parts.push(hint('Click a line of text to edit it. The original stays in the file under a cover — use Redact to remove it.'));
  if (tools.tool === 'redact' || (sel.length && sel.every((a) => a.type === 'redact'))) {
    parts.push(hint('Select text or drag over areas to mark them'), h('button', { class: 'primary small', textContent: 'Apply redactions…', onclick: () => run('apply-redactions') }));
  }
  if (tools.tool === 'place') parts.unshift(hint('Click on a page to place it · Esc to cancel'));
  if (tools.tool === 'pickrect') parts.unshift(hint('Drag a rectangle for the signature · Esc to cancel'));
  if (tools.tool === 'whiteout') parts.push(hint('Covers content visually; underlying text is not removed — use Redact for that'));
  if (sel.length) {
    parts.push(h('div', { class: 'sep' }));
    parts.push(h('span', { class: 'hint', textContent: S.describeSelection() }));
    parts.push(iconButton(MessageSquarePlus, 'Comment on this', () => run('comment-selection')));
    parts.push(iconButton(Copy, 'Duplicate', () => tools.copy() && tools.paste()));
    parts.push(iconButton(Trash2, 'Delete (Del)', () => tools.deleteSelection(), 'danger'));
  }
  propsbar.replaceChildren(...parts);
  propsbar.classList.toggle('show', parts.length > 0 && S.model.loaded);
}

async function chooseTool(id: RailTool) {
  if (!S.model.loaded) return;
  const tools = S.tools;
  if (id === 'image') {
    const f = await pickImageFile();
    if (!f) return;
    const asset = await makeImageAsset(new Uint8Array(await f.arrayBuffer()), f.type);
    S.model.images.set(asset.id, asset);
    tools.startPlacing({ kind: 'image', img: asset.id, w: asset.w, h: asset.h });
    return;
  }
  if (id === 'signature') {
    const url = await signatureDialog();
    if (!url) return;
    const asset = await makeImageAsset(new Uint8Array(await (await fetch(url)).arrayBuffer()), 'image/png');
    S.model.images.set(asset.id, asset);
    // Signature canvases are drawn at 2x; place them at a natural handwriting size.
    tools.startPlacing({ kind: 'image', img: asset.id, w: asset.w / 2, h: asset.h / 2 });
    return;
  }
  if (id === 'stamp') {
    const choice = await stampDialog(authorName());
    if (!choice) return;
    if (choice === 'image') return chooseTool('image');
    tools.startPlacing(choice);
    return;
  }
  tools.setTool(id);
}

function moreMenu(e?: unknown) {
  const ev = e as MouseEvent | undefined;
  const r = (ev?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
  const x = r ? r.left : innerWidth - 260;
  const y = r ? r.bottom + 4 : 50;
  contextMenu(x, y, [
    { label: 'Recognize text (OCR)…', icon: ScanText, action: () => run('ocr') },
    { label: 'Apply redactions…', icon: EyeOff, action: () => run('apply-redactions') },
    'sep',
    { label: 'Header & footer…', icon: Heading, action: () => run('header-footer') },
    { label: 'Watermark…', icon: Droplets, action: () => run('watermark') },
    'sep',
    { label: 'Split document…', icon: Scissors, action: () => run('split') },
    { label: 'Export selected pages…', icon: FileOutput, action: () => run('export-pages') },
    { label: 'Reduce file size…', icon: Shrink, action: () => run('compress') },
    { label: 'Protect with password…', icon: FileLock, action: () => run('protect') },
    'sep',
    { label: 'Sign with certificate…', icon: FileKey, action: () => run('digital-sign') },
    { label: 'Verify signatures', icon: ShieldCheck, action: () => run('verify-signatures') },
    'sep',
    { label: 'Presentation (F5)', icon: Presentation, action: () => run('present') },
  ]);
}

// ------------------------------------------------------------------ find

let lastRevealed = -1;
function updateFind() {
  const s = S.search;
  const n = s.matches.length;
  findCount.textContent = s.query ? (n ? `${s.current + 1} of ${n}${s.running ? '+' : ''}` : s.running ? '…' : 'No results') : '';
  if (s.current >= 0 && s.current !== lastRevealed) {
    lastRevealed = s.current;
    S.viewer.revealMatch(s.matches[s.current].pageKey);
  }
  if (s.current < 0) lastRevealed = -1;
}

function openFind() {
  if (!S.model.loaded) return;
  findbar.hidden = false;
  const sel = document.getSelection()?.toString().trim();
  if (sel && sel.length < 100 && !sel.includes('\n')) findInput.value = sel;
  findInput.focus();
  findInput.select();
  if (findInput.value) S.search.run(findInput.value);
}

function closeFind() {
  findbar.hidden = true;
  findInput.value = '';
  S.search.clear();
  S.container.focus();
}

let findTimer = 0;
findInput.addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = window.setTimeout(() => S.search.run(findInput.value), 200);
});
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    if (S.search.query !== findInput.value) S.search.run(findInput.value);
    else S.search.step(e.shiftKey ? -1 : 1);
  }
  if (e.key === 'Escape') closeFind();
});

// ------------------------------------------------------------------ recent files

function renderRecent() {
  const list = native ? recentFiles() : [];
  recentList.replaceChildren(
    ...(list.length ? [h('h2', { textContent: 'Recent' })] : []),
    ...list.map((r) =>
      h(
        'button',
        {
          class: 'recent-item',
          title: r.path,
          onclick: async () => {
            try {
              await openFiles([await native!.readFile(r.path)]);
            } catch {
              toast(`${r.name} could not be found`, 'error');
              localStorage.setItem('recent', JSON.stringify(recentFiles().filter((x) => x.path !== r.path)));
              renderRecent();
            }
          },
        },
        icon(FileText, 16),
        h('span', { class: 'recent-name', textContent: r.name }),
        h('span', { class: 'recent-path', textContent: r.path.replace(/\/[^/]+$/, '') }),
      ),
    ),
  );
}

// ------------------------------------------------------------------ presentation

let presentState: { layout: Layout; fit: typeof S.viewer.fitMode; scale: number } | null = null;

async function startPresentation() {
  if (!S.model.loaded || presentState) return;
  presentState = { layout: S.viewer.layout, fit: S.viewer.fitMode, scale: S.viewer.scale };
  document.body.classList.add('presenting');
  S.tools.setTool('select');
  try {
    await document.documentElement.requestFullscreen();
  } catch {
    /* fullscreen may be refused; presenting in the window still works */
  }
  S.viewer.setLayout('single');
  requestAnimationFrame(() => S.viewer.fit('page'));
}

function stopPresentation() {
  if (!presentState) return;
  const p = presentState;
  presentState = null;
  document.body.classList.remove('presenting');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  S.viewer.setLayout(p.layout);
  if (p.fit) S.viewer.fit(p.fit);
  else S.viewer.setScale(p.scale);
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && presentState) stopPresentation();
});

// ------------------------------------------------------------------ settings

function applySettings() {
  applyTheme();
  document.body.classList.toggle('night-pages', settings.nightPages);
  nightBtn.classList.toggle('active', settings.nightPages);
  for (const s of sessions) s.viewer.drawOverlays();
  rulers.schedule();
  updateProps();
}
settingsEvents.addEventListener('change', applySettings);

async function openSettings() {
  const r = await settingsDialog(S.tools.style);
  if (!r) return;
  Object.assign(S.tools.style, r.style);
  S.tools.saveStyle();
  updateSettings(r.settings);
}

// ------------------------------------------------------------------ commands

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.matches('input:not([type=checkbox]):not([type=color]), textarea, select') || el.isContentEditable);
};

async function run(cmd: string, arg?: unknown) {
  const loaded = S.model.loaded;
  const m = S.model;
  switch (cmd) {
    case 'open':
      return openFiles(await openDialog());
    case 'open-paths': {
      const files: OpenedFile[] = [];
      for (const p of (arg as string[]) ?? []) {
        try {
          files.push(await native!.readFile(p));
        } catch {
          toast(`Could not read ${p}`, 'error');
        }
      }
      for (const f of files) await openFiles([f]);
      return;
    }
    case 'save':
      return S.save(false);
    case 'save-as':
      return S.save(true);
    case 'save-all':
      for (const s of sessions.filter((x) => x.model.dirty)) {
        activate(s);
        if (!(await s.save(false))) return;
      }
      return;
    case 'save-and-close':
      for (const s of sessions.filter((x) => x.model.dirty)) {
        activate(s);
        if (!(await s.save(false))) return;
      }
      native?.forceClose();
      return;
    case 'close-tab':
      return closeSession(S);
    case 'next-tab':
    case 'prev-tab': {
      if (sessions.length < 2) return;
      const i = sessions.indexOf(S) + (cmd === 'next-tab' ? 1 : -1);
      return activate(sessions[(i + sessions.length) % sessions.length]);
    }
    case 'print':
      return S.print();
    case 'undo':
      if (isTyping()) return document.execCommand('undo');
      S.tools.select([]);
      return m.undo();
    case 'redo':
      if (isTyping()) return document.execCommand('redo');
      S.tools.select([]);
      return m.redo();
    case 'delete':
      if (isTyping()) return document.execCommand('delete');
      return S.tools.deleteSelection();
    case 'find':
      return openFind();
    case 'settings':
      return openSettings();
    case 'zoom-in':
      return loaded && S.viewer.zoomStep(1);
    case 'zoom-out':
      return loaded && S.viewer.zoomStep(-1);
    case 'zoom-100':
      return loaded && S.viewer.setScale(1);
    case 'fit-width':
      return loaded && S.viewer.fit('width');
    case 'fit-page':
      return loaded && S.viewer.fit('page');
    case 'layout-continuous':
    case 'layout-facing':
    case 'layout-single':
      S.viewer.setLayout(cmd.slice(7) as Layout);
      layoutSelect.value = S.viewer.layout;
      return;
    case 'present':
      return startPresentation();
    case 'toggle-sidebar':
      document.body.classList.toggle('sidebar-hidden');
      return;
    case 'show-comments':
    case 'show-bookmarks':
      document.body.classList.remove('sidebar-hidden');
      return S.sidebar.showTab(cmd === 'show-comments' ? 'comments' : 'bookmarks');
    case 'toggle-rulers':
      return updateSettings({ rulers: !settings.rulers });
    case 'toggle-grid':
      return updateSettings({ grid: !settings.grid });
    case 'toggle-night':
      return updateSettings({ nightPages: !settings.nightPages });
    case 'theme-system':
    case 'theme-light':
    case 'theme-dark':
      return updateSettings({ theme: cmd.slice(6) as Theme });
    case 'rotate-cw':
      return loaded && S.rotatePages(S.sidebar.targetKeys(), 90);
    case 'rotate-ccw':
      return loaded && S.rotatePages(S.sidebar.targetKeys(), -90);
    case 'insert-blank':
      return loaded && S.insertBlank();
    case 'insert-file':
      return loaded && S.insertOpened(await openDialog(), S.viewer.currentIndex + 1);
    case 'duplicate-pages':
      return loaded && S.duplicatePages(S.sidebar.targetKeys());
    case 'delete-pages':
      return loaded && S.deletePages(S.sidebar.targetKeys());
    case 'export-pages':
      return loaded && S.exportPages(S.sidebar.targetKeys());
    case 'split':
      return loaded && S.split(await splitDialog(m.pages.length, m.outline.length > 0));
    case 'compress':
      return loaded && S.compress();
    case 'protect': {
      if (!loaded) return;
      const r = await protectDialog(m.security);
      if (r === null) return;
      m.security = r === 'remove' ? null : r;
      m.dirty = true;
      updateChrome();
      renderTabs();
      updateWindowState();
      toast(r === 'remove' ? 'Protection will be removed when you save' : 'Password protection will be applied when you save');
      return;
    }
    case 'digital-sign':
      return loaded && S.digitalSign();
    case 'verify-signatures':
      return loaded && S.checkSignatures();
    case 'ocr':
      return loaded && S.ocr();
    case 'apply-redactions':
      return loaded && S.applyRedactions();
    case 'header-footer': {
      if (!loaded) return;
      const r = await headerFooterDialog(m.headerFooter);
      if (r !== null) m.edit('annots', () => (m.headerFooter = r === 'remove' ? null : r));
      return;
    }
    case 'watermark': {
      if (!loaded) return;
      const r = await watermarkDialog(m.watermark);
      if (r !== null) m.edit('annots', () => (m.watermark = r === 'remove' ? null : r));
      return;
    }
    case 'add-bookmark':
      if (!loaded) return;
      document.body.classList.remove('sidebar-hidden');
      S.sidebar.showTab('bookmarks');
      return S.sidebar.outline.add();
    case 'comment-selection': {
      const id = [...S.viewer.selected][0];
      if (!id) return;
      document.body.classList.remove('sidebar-hidden');
      S.sidebar.showTab('comments');
      S.sidebar.comments.setActive(id);
      requestAnimationFrame(() => (S.sidebar.comments.el.querySelector(`[data-id="${CSS.escape(id)}"] textarea`) as HTMLElement | null)?.focus());
      return;
    }
    default:
      if (cmd.startsWith('tool-')) {
        const t = cmd.slice(5) as RailTool;
        return chooseTool(t);
      }
  }
}

native?.onCommand((cmd, arg) => run(cmd, arg));

const TOOL_KEYS: Record<string, RailTool> = {
  v: 'select',
  h: 'hand',
  t: 'text',
  e: 'edittext',
  n: 'note',
  u: 'highlight',
  d: 'draw',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  m: 'measure',
  k: 'stamp',
  i: 'image',
  s: 'signature',
  f: 'field',
  w: 'whiteout',
  x: 'redact',
};

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  const typing = isTyping();
  if (presentState) {
    if (['arrowright', 'arrowdown', 'pagedown', ' ', 'enter'].includes(k)) S.viewer.scrollToPage(S.viewer.currentIndex + 1);
    else if (['arrowleft', 'arrowup', 'pageup', 'backspace'].includes(k)) S.viewer.scrollToPage(S.viewer.currentIndex - 1);
    else if (k === 'home') S.viewer.scrollToPage(0);
    else if (k === 'end') S.viewer.scrollToPage(S.model.pages.length - 1);
    else if (k === 'escape') stopPresentation();
    else return;
    e.preventDefault();
    return;
  }
  if (ctrl) {
    const map: Record<string, string> = {
      o: 'open',
      p: 'print',
      f: 'find',
      w: 'close-tab',
      '=': 'zoom-in',
      '+': 'zoom-in',
      '-': 'zoom-out',
      '0': 'fit-page',
      '1': 'zoom-100',
      '2': 'fit-width',
      ']': 'rotate-cw',
      '[': 'rotate-ccw',
      ',': 'settings',
      b: 'add-bookmark',
      r: 'toggle-rulers',
      "'": 'toggle-grid',
    };
    let cmd = map[k];
    if (k === 's') cmd = e.shiftKey ? 'save-as' : 'save';
    if (k === 'tab') cmd = e.shiftKey ? 'prev-tab' : 'next-tab';
    if (!typing && k === 'z') cmd = e.shiftKey ? 'redo' : 'undo';
    if (!typing && k === 'y') cmd = 'redo';
    if (k === 'n' && native) {
      e.preventDefault();
      native.newWindow();
      return;
    }
    if (cmd) {
      e.preventDefault();
      run(cmd);
    }
    return;
  }
  if (e.key === 'F4' || e.key === 'F5') {
    e.preventDefault();
    run(e.key === 'F4' ? 'toggle-sidebar' : 'present');
    return;
  }
  if (typing || e.altKey) return;
  if (e.key === 'Escape') {
    if (!findbar.hidden) closeFind();
    else if (S.tools.tool !== 'select') S.tools.setTool('select');
    else S.tools.select([]);
    return;
  }
  if (!S.model.loaded) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.tools.deleteSelection()) e.preventDefault();
    return;
  }
  if (e.key.startsWith('Arrow') && S.tools.selection.length) {
    const d = e.shiftKey ? 10 : 1;
    const [dx, dy] = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key]!;
    if (S.tools.nudge(dx, dy)) e.preventDefault();
    return;
  }
  if (S.viewer.layout === 'single' && ['PageDown', 'PageUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
    e.preventDefault();
    S.viewer.scrollToPage(S.viewer.currentIndex + (e.key === 'PageDown' || e.key === 'ArrowRight' ? 1 : -1));
    return;
  }
  if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    S.viewer.scrollToPage(e.key === 'Home' ? 0 : S.model.pages.length - 1);
    return;
  }
  if (TOOL_KEYS[k] && !e.shiftKey) {
    e.preventDefault();
    chooseTool(TOOL_KEYS[k]);
  }
});

// ------------------------------------------------------------------ clipboard

const CLIP_MIME = 'application/x-pdf-editor-annots';
const hasTextSelection = () => !!document.getSelection() && !document.getSelection()!.isCollapsed;
document.addEventListener('copy', (e) => {
  if (isTyping() || hasTextSelection()) return;
  if (S.tools.copy()) {
    e.preventDefault();
    e.clipboardData?.setData(CLIP_MIME, '1');
    e.clipboardData?.setData('text/plain', '');
  }
});
document.addEventListener('cut', (e) => {
  if (isTyping() || hasTextSelection()) return;
  if (S.tools.copy()) {
    e.preventDefault();
    e.clipboardData?.setData(CLIP_MIME, '1');
    S.tools.deleteSelection();
  }
});
document.addEventListener('paste', async (e) => {
  if (isTyping() || !S.model.loaded) return;
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
  if (file) {
    e.preventDefault();
    const asset = await makeImageAsset(new Uint8Array(await file.arrayBuffer()), file.type);
    S.model.images.set(asset.id, asset);
    const v = S.viewer.order[S.viewer.currentIndex];
    if (!v) return;
    const r = S.container.getBoundingClientRect();
    const vr = v.el.getBoundingClientRect();
    const cx = Math.min(Math.max(r.left + r.width / 2, vr.left), vr.right);
    const cy = Math.min(Math.max(r.top + r.height / 2, vr.top), vr.bottom);
    S.tools.placing = { kind: 'image', img: asset.id, w: asset.w, h: asset.h };
    S.tools.placeAt(v, v.toPdf(cx, cy));
    return;
  }
  if (S.tools.hasClipboard && (e.clipboardData?.types.includes(CLIP_MIME) || !e.clipboardData?.types.length)) {
    e.preventDefault();
    S.tools.paste();
  }
});

// ------------------------------------------------------------------ drag & drop onto the window

window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    document.body.classList.add('dropping');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) openFiles(await Promise.all(files.map(fromFile)));
});

// ------------------------------------------------------------------ boot

window.addEventListener('beforeunload', (e) => {
  // Electron handles unsaved-changes prompts natively in the main process.
  if (!native && sessions.some((s) => s.model.dirty)) e.preventDefault();
});

activate(newSession());
applySettings();
if (native) {
  if (!settings.author) native.userName().then((n) => !settings.author && updateSettings({ author: n }));
  native.initialFiles().then(async (paths) => {
    if (paths.length) await run('open-paths', paths);
  });
}
