export interface OpenedFile {
  path: string | null;
  name: string;
  data: Uint8Array;
}

export interface SignOptions {
  data: Uint8Array;
  p12Path: string;
  password: string;
  pageIndex: number;
  rect: [number, number, number, number];
  name: string;
  reason: string;
  location: string;
  contact: string;
}

export interface SignatureStatus {
  field: string;
  signer: string;
  date: string | null;
  reason: string | null;
  location: string | null;
  intact: boolean;
  coversWholeFile: boolean;
  selfSigned: boolean;
  error?: string;
}

export interface ToolAvailability {
  qpdf: boolean;
  gs: boolean;
  tesseract: boolean;
}

interface Bridge {
  initialFiles(): Promise<string[]>;
  openDialog(): Promise<OpenedFile[]>;
  readFile(path: string): Promise<OpenedFile>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  saveDialog(defaultPath: string): Promise<string | null>;
  chooseDir(): Promise<string | null>;
  readSystemFont(): Promise<Uint8Array | null>;
  setTitle(t: string): void;
  setDirty(d: boolean): void;
  setTheme(t: 'system' | 'light' | 'dark'): void;
  forceClose(): void;
  newWindow(files?: string[]): void;
  openExternal(url: string): void;
  pathForFile(file: File): string;
  onCommand(cb: (cmd: string, arg?: unknown) => void): void;
  userName(): Promise<string>;
  tools(): Promise<ToolAvailability>;
  qpdf(args: string[], data: Uint8Array): Promise<Uint8Array>;
  ghostscript(data: Uint8Array, preset: string): Promise<Uint8Array>;
  ocr(png: Uint8Array, lang: string): Promise<string>;
  ocrLangs(): Promise<string[]>;
  signPdf(opts: SignOptions): Promise<Uint8Array>;
  verifySignatures(data: Uint8Array): Promise<SignatureStatus[]>;
  createDigitalId(opts: { name: string; email: string; org: string; password: string }): Promise<string | null>;
  pickDigitalId(): Promise<string | null>;
}

declare global {
  interface Window {
    native?: Bridge;
  }
}

export const native = window.native;

let toolCache: Promise<ToolAvailability> | null = null;
export function availableTools(): Promise<ToolAvailability> {
  if (!native) return Promise.resolve({ qpdf: false, gs: false, tesseract: false });
  toolCache ??= native.tools();
  return toolCache;
}

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => resolve([...(input.files ?? [])]);
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

export async function fromFile(f: File): Promise<OpenedFile> {
  const path = native?.pathForFile(f) || null;
  return { path, name: f.name, data: new Uint8Array(await f.arrayBuffer()) };
}

export async function openDialog(): Promise<OpenedFile[]> {
  if (native) return native.openDialog();
  const files = await pickFiles('.pdf,application/pdf,image/*');
  return Promise.all(files.map(fromFile));
}

export function download(data: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Returns the path written to (native) or the file name (browser download), or null if cancelled. */
export async function saveBytes(data: Uint8Array, name: string, path: string | null, askPath: boolean) {
  if (native) {
    let target = path;
    if (askPath || !target) target = await native.saveDialog(target ?? name);
    if (!target) return null;
    await native.writeFile(target, data);
    return { path: target, name: target.split('/').pop()! };
  }
  download(data, name);
  return { path: null, name };
}

export function openExternal(url: string) {
  if (native) native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
