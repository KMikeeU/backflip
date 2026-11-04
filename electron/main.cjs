const { app, BrowserWindow, Menu, dialog, ipcMain, nativeTheme, net, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_NAME = 'PDF Editor';
const DIST = path.join(__dirname, '..', 'dist');
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DOC_RE = /\.(pdf|png|jpe?g|webp|gif|bmp)$/i;

app.setName(APP_NAME);
app.setDesktopName('pdf-editor.desktop');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const pendingFiles = new Map(); // webContents.id -> string[]
const dirty = new Map(); // window.id -> boolean
const forceClose = new Set();
let lastFocused = null;

function filesFromArgv(argv, cwd) {
  // System electron is launched as `electron <appdir> [files...]`, so the first two entries are never documents.
  return argv
    .slice(2)
    .filter((a) => !a.startsWith('-'))
    .map((a) => path.resolve(cwd, a))
    .filter((p) => DOC_RE.test(p) && fs.existsSync(p) && fs.statSync(p).isFile());
}

function createWindow(files = []) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f3f4f6',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  pendingFiles.set(win.webContents.id, files);
  win.on('focus', () => (lastFocused = win));
  lastFocused = win;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault();
      if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('close', (e) => {
    if (forceClose.has(win.id) || !dirty.get(win.id)) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save All', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Save changes before closing?',
      detail: 'Some open documents have unsaved changes. They will be lost if you don’t save them.',
    });
    if (choice === 0) win.webContents.send('command', 'save-and-close');
    else if (choice === 1) {
      forceClose.add(win.id);
      win.close();
    }
  });
  win.on('closed', () => {
    dirty.delete(win.id);
    forceClose.delete(win.id);
    if (lastFocused === win) lastFocused = null;
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadURL('app://bundle/index.html');
  return win;
}

function targetWindow() {
  const w = BrowserWindow.getFocusedWindow() ?? lastFocused ?? BrowserWindow.getAllWindows()[0];
  return w && !w.isDestroyed() ? w : null;
}

function send(cmd, arg) {
  const win = targetWindow();
  if (win) win.webContents.send('command', cmd, arg);
  else if (cmd === 'open') createWindow();
}

function item(label, cmd, accelerator) {
  // The renderer handles shortcuts itself (so they also work in the browser build); only display them here.
  return { label, accelerator, registerAccelerator: false, click: () => send(cmd) };
}

function buildMenu() {
  const sep = { type: 'separator' };
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New Window', accelerator: 'Ctrl+N', click: () => createWindow() },
        item('Open…', 'open', 'Ctrl+O'),
        sep,
        item('Save', 'save', 'Ctrl+S'),
        item('Save As…', 'save-as', 'Ctrl+Shift+S'),
        item('Save All', 'save-all'),
        sep,
        item('Export Selected Pages…', 'export-pages'),
        item('Split Document…', 'split'),
        item('Reduce File Size…', 'compress'),
        item('Protect with Password…', 'protect'),
        sep,
        item('Sign with Certificate…', 'digital-sign'),
        item('Verify Signatures', 'verify-signatures'),
        sep,
        item('Print…', 'print', 'Ctrl+P'),
        sep,
        item('Close Tab', 'close-tab', 'Ctrl+W'),
        { label: 'Close Window', accelerator: 'Ctrl+Shift+W', role: 'close' },
        { label: 'Quit', accelerator: 'Ctrl+Q', role: 'quit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        item('Undo', 'undo', 'Ctrl+Z'),
        item('Redo', 'redo', 'Ctrl+Shift+Z'),
        sep,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        item('Delete', 'delete', 'Delete'),
        sep,
        item('Find…', 'find', 'Ctrl+F'),
        sep,
        item('Preferences…', 'settings', 'Ctrl+,'),
      ],
    },
    {
      label: '&View',
      submenu: [
        item('Zoom In', 'zoom-in', 'Ctrl+='),
        item('Zoom Out', 'zoom-out', 'Ctrl+-'),
        item('Actual Size', 'zoom-100', 'Ctrl+1'),
        item('Fit Width', 'fit-width', 'Ctrl+2'),
        item('Fit Page', 'fit-page', 'Ctrl+0'),
        sep,
        { label: 'Page Layout', submenu: [item('Continuous', 'layout-continuous'), item('Two Pages', 'layout-facing'), item('Single Page', 'layout-single')] },
        item('Presentation', 'present', 'F5'),
        sep,
        item('Toggle Sidebar', 'toggle-sidebar', 'F4'),
        item('Comments', 'show-comments'),
        item('Bookmarks', 'show-bookmarks'),
        item('Rulers', 'toggle-rulers', 'Ctrl+R'),
        item('Grid', 'toggle-grid', "Ctrl+'"),
        item('Night Mode Pages', 'toggle-night'),
        { label: 'Theme', submenu: [item('System', 'theme-system'), item('Light', 'theme-light'), item('Dark', 'theme-dark')] },
        sep,
        item('Next Tab', 'next-tab', 'Ctrl+Tab'),
        item('Previous Tab', 'prev-tab', 'Ctrl+Shift+Tab'),
        { role: 'togglefullscreen' },
        sep,
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: '&Tools',
      submenu: [
        item('Edit Text', 'tool-edittext', 'E'),
        item('Recognize Text (OCR)…', 'ocr'),
        sep,
        item('Redact', 'tool-redact', 'X'),
        item('Apply Redactions…', 'apply-redactions'),
        sep,
        item('Stamps…', 'tool-stamp'),
        item('Form Fields', 'tool-field', 'F'),
        item('Measure', 'tool-measure', 'M'),
        sep,
        item('Header & Footer…', 'header-footer'),
        item('Watermark…', 'watermark'),
        item('Add Bookmark', 'add-bookmark', 'Ctrl+B'),
      ],
    },
    {
      label: '&Document',
      submenu: [
        item('Rotate Pages Clockwise', 'rotate-cw', 'Ctrl+]'),
        item('Rotate Pages Counterclockwise', 'rotate-ccw', 'Ctrl+['),
        item('Insert Blank Page', 'insert-blank'),
        item('Insert Pages from File…', 'insert-file'),
        item('Duplicate Pages', 'duplicate-pages'),
        item('Delete Pages', 'delete-pages'),
      ],
    },
    {
      label: '&Help',
      submenu: [
        {
          label: `About ${APP_NAME}`,
          click: () =>
            dialog.showMessageBox({
              message: APP_NAME,
              detail: `Version ${app.getVersion()}\nElectron ${process.versions.electron}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function readDoc(p) {
  const data = await fsp.readFile(p);
  return { path: p, name: path.basename(p), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function which(cmd) {
  return (process.env.PATH || '/usr/bin').split(':').some((d) => {
    try {
      fs.accessSync(path.join(d, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function run(cmd, args, okCodes = [0]) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (okCodes.includes(code)) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().split('\n').pop() || `${cmd} exited with ${code}`));
    });
  });
}

/** Runs a tool that reads an input file and writes an output file, returning the output bytes. */
async function withTemp(data, ext, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdf-editor-'));
  try {
    const input = path.join(dir, `in${ext}`);
    const output = path.join(dir, 'out.pdf');
    await fsp.writeFile(input, data);
    const res = await fn(input, output);
    if (res !== undefined) return res;
    const b = await fsp.readFile(output);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function realName() {
  const user = os.userInfo().username;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(`${user}:`));
    const gecos = line?.split(':')[4]?.split(',')[0];
    if (gecos) return gecos;
  } catch {}
  return user;
}

function registerIpc() {
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  const signing = () => require('./signing.cjs');

  ipcMain.handle('initial-files', (e) => {
    const files = pendingFiles.get(e.sender.id) ?? [];
    pendingFiles.delete(e.sender.id);
    return files;
  });
  ipcMain.handle('open-dialog', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'PDF & Images', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (r.canceled) return [];
    return Promise.all(r.filePaths.map(readDoc));
  });
  ipcMain.handle('read-file', (_e, p) => readDoc(p));
  ipcMain.handle('write-file', async (_e, p, data) => {
    // Write to a temp file and rename so a failed save never truncates the original.
    const tmp = `${p}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, p);
    app.addRecentDocument(p);
  });
  ipcMain.handle('save-dialog', async (e, defaultPath) => {
    const r = await dialog.showSaveDialog(winOf(e), { defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return null;
    return /\.pdf$/i.test(r.filePath) ? r.filePath : `${r.filePath}.pdf`;
  });
  ipcMain.handle('choose-dir', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('read-system-font', async () => {
    const candidates = [
      '/usr/share/fonts/noto/NotoSans-Regular.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf',
      '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
      '/usr/share/fonts/TTF/LiberationSans-Regular.ttf',
      '/usr/share/fonts/gnu-free/FreeSans.otf',
    ];
    for (const c of candidates) {
      try {
        const b = await fsp.readFile(c);
        return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      } catch {}
    }
    return null;
  });
  ipcMain.handle('user-name', () => realName());
  ipcMain.handle('tools', () => ({ qpdf: which('qpdf'), gs: which('gs'), tesseract: which('tesseract') }));
  ipcMain.handle('qpdf', (_e, args, data) =>
    // qpdf exits with 3 when it succeeded with warnings.
    withTemp(data, '.pdf', async (input, output) => void (await run('qpdf', [...args, input, output], [0, 3]))),
  );
  ipcMain.handle('ghostscript', (_e, data, preset) => {
    if (!['screen', 'ebook', 'printer', 'prepress'].includes(preset)) throw new Error('bad preset');
    return withTemp(data, '.pdf', async (input, output) =>
      void (await run('gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.7', `-dPDFSETTINGS=/${preset}`, '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${output}`, input])),
    );
  });
  ipcMain.handle('ocr', (_e, png, lang) => {
    if (!/^[A-Za-z0-9_+]+$/.test(lang)) throw new Error('bad language');
    return withTemp(png, '.png', async (input) => (await run('tesseract', [input, 'stdout', '-l', lang, '--dpi', '300', 'tsv'])).toString('utf8'));
  });
  ipcMain.handle('ocr-langs', async () => {
    const out = (await run('tesseract', ['--list-langs'])).toString('utf8');
    return out.split('\n').slice(1).map((s) => s.trim()).filter((s) => s && s !== 'osd');
  });
  ipcMain.handle('sign-pdf', async (_e, opts) => {
    const p12 = await fsp.readFile(opts.p12Path);
    return signing().signPdf({ ...opts, p12 });
  });
  ipcMain.handle('verify-signatures', (_e, data) => signing().verifySignatures(data));
  ipcMain.handle('create-digital-id', async (e, opts) => {
    const r = await dialog.showSaveDialog(winOf(e), {
      title: 'Save Digital ID',
      defaultPath: path.join(app.getPath('documents'), `${opts.name.replace(/[^\w.-]+/g, '_') || 'digital-id'}.p12`),
      filters: [{ name: 'PKCS#12 Digital ID', extensions: ['p12', 'pfx'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, signing().createDigitalId(opts), { mode: 0o600 });
    return r.filePath;
  });
  ipcMain.handle('pick-digital-id', async (e) => {
    const r = await dialog.showOpenDialog(winOf(e), { properties: ['openFile'], filters: [{ name: 'Digital ID', extensions: ['p12', 'pfx'] }] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.on('set-title', (e, title) => winOf(e)?.setTitle(title));
  ipcMain.on('set-dirty', (e, d) => {
    const w = winOf(e);
    if (w) dirty.set(w.id, !!d);
  });
  ipcMain.on('set-theme', (_e, t) => {
    if (['system', 'light', 'dark'].includes(t)) nativeTheme.themeSource = t;
  });
  ipcMain.on('force-close', (e) => {
    const w = winOf(e);
    if (!w) return;
    forceClose.add(w.id);
    w.close();
  });
  ipcMain.on('new-window', (_e, files) => createWindow(files ?? []));
  ipcMain.on('open-external', (_e, url) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    const win = targetWindow();
    // Like Acrobat, files opened from the file manager become tabs in the existing window.
    if (win && files.length) {
      win.webContents.send('command', 'open-paths', files);
      if (win.isMinimized()) win.restore();
      win.focus();
    } else createWindow(files);
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      const { pathname } = new URL(req.url);
      const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
      if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
    registerIpc();
    buildMenu();
    createWindow(filesFromArgv(process.argv, process.cwd()));
  });

  app.on('window-all-closed', () => app.quit());
}
