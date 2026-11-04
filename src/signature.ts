import '@fontsource/great-vibes/400.css';
import '@fontsource/dancing-script/400.css';
import '@fontsource/sacramento/400.css';
import '@fontsource/caveat/400.css';
import { customDialog, h } from './ui';

const SIGNATURE_FONTS = ['Great Vibes', 'Dancing Script', 'Sacramento', 'Caveat'];

const KEY = 'signatures';
const loadSaved = (): string[] => JSON.parse(localStorage.getItem(KEY) ?? '[]');

function trim(canvas: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = canvas.getContext('2d')!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d')!.drawImage(canvas, -x0, -y0);
  return out;
}

/** Resolves to a PNG data URL of the chosen signature, or null. */
export function signatureDialog(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: string | null, close: () => void) => {
      if (settled) return;
      settled = true;
      close();
      resolve(v);
    };
    customDialog(
      (close) => {
        const W = 640,
          H = 220;
        const canvas = h('canvas', { class: 'sig-canvas', width: W * 2, height: H * 2 });
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
        const ctx = canvas.getContext('2d')!;
        ctx.scale(2, 2);
        ctx.lineCap = ctx.lineJoin = 'round';
        let color = '#0b1f5c';
        let mode: 'draw' | 'type' = 'draw';
        const typed = h('input', { class: 'sig-typed', placeholder: 'Type your name', hidden: true });
        const fontSel = h('select', { hidden: true }, ...SIGNATURE_FONTS.map((f) => h('option', { value: f, textContent: f })));
        const renderTyped = async () => {
          const family = `"${fontSel.value}", cursive`;
          // Webfonts load lazily; drawing before they are ready would use the fallback font.
          await document.fonts.load(`72px "${fontSel.value}"`, typed.value || 'a');
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = color;
          let size = 80;
          ctx.font = `${size}px ${family}`;
          while (ctx.measureText(typed.value).width > W - 40 && size > 20) ctx.font = `${(size -= 4)}px ${family}`;
          ctx.textBaseline = 'middle';
          ctx.fillText(typed.value, 20, H / 2);
        };
        typed.oninput = renderTyped;
        fontSel.onchange = renderTyped;

        let last: [number, number] | null = null;
        canvas.addEventListener('pointerdown', (e) => {
          if (mode !== 'draw') return;
          canvas.setPointerCapture(e.pointerId);
          last = [e.offsetX, e.offsetY];
        });
        canvas.addEventListener('pointermove', (e) => {
          if (!last) return;
          const pressure = e.pressure && e.pointerType === 'pen' ? e.pressure : 0.5;
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5 + pressure * 2.5;
          ctx.beginPath();
          ctx.moveTo(...last);
          ctx.lineTo(e.offsetX, e.offsetY);
          ctx.stroke();
          last = [e.offsetX, e.offsetY];
        });
        canvas.addEventListener('pointerup', () => (last = null));

        const tabDraw = h('button', { class: 'tab active', textContent: 'Draw' });
        const tabType = h('button', { class: 'tab', textContent: 'Type' });
        const setMode = (m: typeof mode) => {
          mode = m;
          tabDraw.classList.toggle('active', m === 'draw');
          tabType.classList.toggle('active', m === 'type');
          typed.hidden = fontSel.hidden = m !== 'type';
          ctx.clearRect(0, 0, W, H);
          if (m === 'type') {
            typed.focus();
            renderTyped();
          }
        };
        tabDraw.onclick = () => setMode('draw');
        tabType.onclick = () => setMode('type');

        const colors = ['#0b1f5c', '#000000', '#1d4ed8'].map((c) =>
          h('button', {
            class: 'swatch',
            title: c,
            style: `background:${c}` as never,
            onclick: () => {
              color = c;
              if (mode === 'type') renderTyped();
            },
          }),
        );

        const saved = loadSaved();
        const savedRow = h(
          'div',
          { class: 'sig-saved' },
          ...saved.map((url, i) => {
            const del = h('button', {
              class: 'sig-del',
              textContent: '×',
              title: 'Remove',
              onclick: (e: Event) => {
                e.stopPropagation();
                const s = loadSaved();
                s.splice(i, 1);
                localStorage.setItem(KEY, JSON.stringify(s));
                (e.target as HTMLElement).parentElement!.remove();
              },
            });
            return h('div', { class: 'sig-thumb', title: 'Use this signature', onclick: () => finish(url, close) }, h('img', { src: url }), del);
          }),
        );

        const remember = h('input', { type: 'checkbox', checked: true });
        const use = () => {
          const t = trim(canvas);
          if (!t) return;
          const url = t.toDataURL('image/png');
          if (remember.checked) localStorage.setItem(KEY, JSON.stringify([url, ...loadSaved()].slice(0, 6)));
          finish(url, close);
        };

        return h(
          'div',
          { class: 'modal sig-modal' },
          h('p', { class: 'modal-msg', textContent: 'Add signature' }),
          saved.length ? h('div', {}, h('p', { class: 'modal-detail', textContent: 'Saved signatures' }), savedRow) : null,
          h('div', { class: 'tabs' }, tabDraw, tabType, h('div', { class: 'spacer' }), ...colors),
          h('div', { class: 'sig-row' }, typed, fontSel),
          canvas,
          h(
            'div',
            { class: 'modal-actions' },
            h('label', { class: 'check' }, remember, ' Remember'),
            h('div', { class: 'spacer' }),
            h('button', { textContent: 'Clear', onclick: () => (mode === 'type' ? ((typed.value = ''), renderTyped()) : ctx.clearRect(0, 0, W, H)) }),
            h('button', { textContent: 'Cancel', onclick: () => finish(null, close) }),
            h('button', { class: 'primary', textContent: 'Place', onclick: use }),
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
