import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { ImageAsset } from './annots';
import { newId } from './annots';
import { promptDialog } from './ui';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const asset = (p: string) => new URL(`pdfjs/${p}/`, document.baseURI).href;

export class PasswordCancelled extends Error {}

export async function loadPdf(bytes: Uint8Array, name: string, onPasswordUsed?: (pw: string) => void) {
  // pdf.js transfers (detaches) the buffer it is given; keep the caller's copy intact for saving.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
    enableXfa: false,
  });
  task.onPassword = async (update: (pw: string) => void, reason: number) => {
    const pw = await promptDialog(
      reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'Incorrect password, try again' : `“${name}” is password protected`,
      { password: true, placeholder: 'Password', ok: 'Unlock' },
    );
    if (pw === null) {
      task.destroy();
      return;
    }
    onPasswordUsed?.(pw);
    update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (task.destroyed) throw new PasswordCancelled('cancelled');
    throw e;
  }
}

export const isPdf = (data: Uint8Array) => {
  const head = new TextDecoder().decode(data.subarray(0, 1024));
  return head.includes('%PDF-');
};

export function isImageName(name: string) {
  return /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(name);
}

function mimeOf(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Normalises any browser-decodable image to PNG/JPEG so pdf-lib can embed it. */
export async function makeImageAsset(data: Uint8Array, mimeHint?: string): Promise<ImageAsset> {
  let mime = mimeOf(data);
  const blob = new Blob([data as BlobPart], { type: mime !== 'application/octet-stream' ? mime : mimeHint || '' });
  const bmp = await createImageBitmap(blob);
  let bytes = data;
  if (mime !== 'image/png' && mime !== 'image/jpeg') {
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const png = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
    bytes = new Uint8Array(await png.arrayBuffer());
    mime = 'image/png';
  }
  const asset: ImageAsset = {
    id: newId(),
    mime: mime as ImageAsset['mime'],
    bytes,
    url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
    w: bmp.width,
    h: bmp.height,
  };
  bmp.close();
  return asset;
}

export { pdfjs };
