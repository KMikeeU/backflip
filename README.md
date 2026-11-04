# PDF Editor

Desktop PDF viewer and editor for Arch Linux. Runs on the system `electron`; pdf.js renders, pdf-lib writes.

## Features

- **Viewing**: tabs, thumbnails, bookmarks, search, continuous / two-page / single-page layouts, presentation mode (F5), night mode, rulers and grid, remembers the last page per file.
- **Annotating**: text, comments with replies, highlight / underline / strikethrough, pen, shapes, lines, arrows, measurements, stamps, images, signatures. Saved as standard PDF annotations, so they stay editable here and in other viewers (or flatten them in Preferences).
- **Editing**: edit existing text lines, whiteout, true redaction (content is removed from the file), header & footer with page numbers, watermarks.
- **Forms**: fill existing forms, create text, checkbox, radio and dropdown fields.
- **Pages**: reorder, rotate, insert, duplicate, delete, merge files, export selections, split by ranges, page count or bookmarks.
- **Security**: open/save password-protected PDFs (AES-256), certificate signatures (PKCS#12, including creating a self-signed ID) and signature verification.
- **OCR**: makes scanned pages searchable via Tesseract.
- **Reduce file size** via qpdf (lossless) or Ghostscript (image downsampling).

## Install (Arch)

```sh
cd packaging/arch && makepkg -si
sudo pacman -S --needed qpdf ghostscript tesseract tesseract-data-eng   # optional tools
```

`packaging/aur/` has a `pdf-editor-git` PKGBUILD for publishing to the AUR (set `url` to the public repository first, then regenerate `.SRCINFO` with `makepkg --printsrcinfo > .SRCINFO`).

## Develop

```sh
npm install
npm run app            # Electron + Vite dev server
npm run dev            # browser-only (save = download)
npm test               # browser end-to-end tests (needs Chrome/Chromium; set CHROME_PATH if not found)
npm run test:electron  # desktop tests: encryption, OCR, signing, split, compression
```
