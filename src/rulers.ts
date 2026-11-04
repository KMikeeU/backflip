import { settings, UNIT_PT } from './settings';
import { h } from './ui';
import type { Viewer } from './viewer';

const SIZE = 20;

/** Rulers along the viewer edges, zeroed at the displayed top-left corner of the current page. */
export class Rulers {
  readonly top = h('canvas', { class: 'ruler ruler-top' });
  readonly left = h('canvas', { class: 'ruler ruler-left' });
  readonly corner = h('div', { class: 'ruler-corner' });
  private viewer: Viewer | null = null;
  private pointer: { x: number; y: number } | null = null;
  private raf = 0;

  constructor(private host: HTMLElement) {
    host.append(this.top, this.left, this.corner);
    new ResizeObserver(() => this.schedule()).observe(host);
  }

  attach(viewer: Viewer | null) {
    this.viewer = viewer;
    if (!viewer) return;
    const c = viewer.container;
    if (!c.dataset.rulersBound) {
      c.dataset.rulersBound = '1';
      c.addEventListener('scroll', () => this.viewer === viewer && this.schedule());
      c.addEventListener('pointermove', (e) => {
        if (this.viewer !== viewer) return;
        this.pointer = { x: e.clientX, y: e.clientY };
        this.schedule();
      });
      c.addEventListener('pointerleave', () => {
        this.pointer = null;
        this.schedule();
      });
      viewer.addEventListener('scalechange', () => this.schedule());
      viewer.addEventListener('pagechange', () => this.schedule());
    }
    this.schedule();
  }

  schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    const on = settings.rulers && !!this.viewer?.order.length;
    this.host.classList.toggle('with-rulers', on);
    if (!on || !this.viewer) return;
    const v = this.viewer.order[this.viewer.currentIndex];
    if (!v) return;
    const hostRect = this.host.getBoundingClientRect();
    const pageRect = v.el.getBoundingClientRect();
    const unitPx = UNIT_PT[settings.units] * this.viewer.scale;
    // Pick a labelled step that keeps major ticks at least ~60px apart.
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    const major = steps.find((s) => s * unitPx >= 60) ?? 1000;
    const minorDiv = major % 10 === 0 || major === 1 ? 10 : 5;
    const style = getComputedStyle(this.host);
    const fg = style.getPropertyValue('--muted') || '#888';
    const bg = style.getPropertyValue('--panel') || '#222';
    const accent = style.getPropertyValue('--accent') || '#4f8cff';
    const dpr = window.devicePixelRatio || 1;

    const paint = (canvas: HTMLCanvasElement, length: number, origin: number, pageLen: number, pointer: number | null, vertical: boolean) => {
      canvas.width = Math.round((vertical ? SIZE : length) * dpr);
      canvas.height = Math.round((vertical ? length : SIZE) * dpr);
      canvas.style.width = `${vertical ? SIZE : length}px`;
      canvas.style.height = `${vertical ? length : SIZE}px`;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, vertical ? SIZE : length, vertical ? length : SIZE);
      ctx.fillStyle = 'rgba(128,128,128,0.18)';
      if (vertical) ctx.fillRect(0, origin, SIZE, pageLen);
      else ctx.fillRect(origin, 0, pageLen, SIZE);
      ctx.strokeStyle = fg;
      ctx.fillStyle = fg;
      ctx.lineWidth = 1;
      ctx.font = '9px sans-serif';
      const minor = (major * unitPx) / minorDiv;
      const first = Math.floor(-origin / minor);
      const last = Math.ceil((length - origin) / minor);
      ctx.beginPath();
      for (let i = first; i <= last; i++) {
        const pos = Math.round(origin + i * minor) + 0.5;
        const isMajor = i % minorDiv === 0;
        const len = isMajor ? SIZE * 0.6 : i % (minorDiv / 2) === 0 ? SIZE * 0.35 : SIZE * 0.2;
        if (vertical) {
          ctx.moveTo(SIZE, pos);
          ctx.lineTo(SIZE - len, pos);
        } else {
          ctx.moveTo(pos, SIZE);
          ctx.lineTo(pos, SIZE - len);
        }
        if (isMajor) {
          const label = String((i / minorDiv) * major);
          if (vertical) {
            ctx.save();
            ctx.translate(9, pos + 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(label, 0, 0);
            ctx.restore();
          } else ctx.fillText(label, pos + 2, 9);
        }
      }
      ctx.stroke();
      if (pointer !== null) {
        ctx.strokeStyle = accent;
        ctx.beginPath();
        if (vertical) {
          ctx.moveTo(0, pointer + 0.5);
          ctx.lineTo(SIZE, pointer + 0.5);
        } else {
          ctx.moveTo(pointer + 0.5, 0);
          ctx.lineTo(pointer + 0.5, SIZE);
        }
        ctx.stroke();
      }
    };
    const viewRect = this.viewer.container.getBoundingClientRect();
    paint(this.top, hostRect.width - SIZE, pageRect.left - viewRect.left, pageRect.width, this.pointer ? this.pointer.x - viewRect.left : null, false);
    paint(this.left, hostRect.height - SIZE, pageRect.top - viewRect.top, pageRect.height, this.pointer ? this.pointer.y - viewRect.top : null, true);
  }
}
