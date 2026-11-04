import { createElement, type IconNode } from 'lucide';

export function icon(node: IconNode, size = 18) {
  return createElement(node, { width: size, height: size, 'stroke-width': 1.75 });
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; dataset?: Record<string, string> } = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, dataset, ...rest } = props;
  if (cls) el.className = cls;
  if (dataset) Object.assign(el.dataset, dataset);
  Object.assign(el, rest);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function iconButton(node: IconNode, title: string, onClick: (e: MouseEvent) => void, cls = '') {
  const b = h('button', { class: `icon-btn ${cls}`, title, onclick: (e: MouseEvent) => onClick(e) }, icon(node, cls.includes('tiny') ? 14 : 18));
  b.setAttribute('aria-label', title);
  return b;
}

function modal(content: HTMLElement, onDismiss: () => void) {
  const backdrop = h('div', { class: 'modal-backdrop' }, content);
  const prevFocus = document.activeElement as HTMLElement | null;
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) onDismiss();
  });
  backdrop.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') onDismiss();
  });
  document.body.append(backdrop);
  return () => {
    backdrop.remove();
    prevFocus?.focus?.();
  };
}

export function promptDialog(
  message: string,
  opts: { value?: string; password?: boolean; placeholder?: string; ok?: string; multiline?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = opts.multiline
      ? h('textarea', { value: opts.value ?? '', placeholder: opts.placeholder ?? '', rows: 5 })
      : h('input', { type: opts.password ? 'password' : 'text', value: opts.value ?? '', placeholder: opts.placeholder ?? '' });
    const done = (v: string | null) => {
      close();
      resolve(v);
    };
    const form = h(
      'form',
      { class: 'modal', onsubmit: (e: Event) => (e.preventDefault(), done(input.value)) },
      h('p', { class: 'modal-msg', textContent: message }),
      input,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { type: 'button', textContent: 'Cancel', onclick: () => done(null) }),
        h('button', { type: 'submit', class: 'primary', textContent: opts.ok ?? 'OK' }),
      ),
    );
    if (opts.multiline)
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter' && (e as KeyboardEvent).ctrlKey) done(input.value);
      });
    const close = modal(form, () => done(null));
    input.focus();
    if (!opts.multiline) (input as HTMLInputElement).select();
  });
}

/** Resolves to the index of the chosen button, or -1 if dismissed. */
export function choiceDialog(message: string, detail: string, buttons: string[], primary = 0): Promise<number> {
  return new Promise((resolve) => {
    const done = (i: number) => {
      close();
      resolve(i);
    };
    const box = h(
      'div',
      { class: 'modal', tabIndex: -1 },
      h('p', { class: 'modal-msg', textContent: message }),
      detail ? h('p', { class: 'modal-detail', textContent: detail }) : null,
      h(
        'div',
        { class: 'modal-actions' },
        ...buttons.map((b, i) => h('button', { textContent: b, class: i === primary ? 'primary' : '', onclick: () => done(i) })),
      ),
    );
    const close = modal(box, () => done(-1));
    (box.querySelector('.primary') as HTMLElement | null)?.focus();
  });
}

export function customDialog(build: (close: () => void) => HTMLElement, onDismiss?: () => void) {
  let close = () => {};
  const content = build(() => close());
  close = modal(content, () => {
    close();
    onDismiss?.();
  });
  return close;
}

export interface MenuItem {
  label: string;
  icon?: IconNode;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export function contextMenu(x: number, y: number, items: (MenuItem | 'sep')[]) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = h(
    'div',
    { class: 'ctx-menu' },
    ...items.map((it) =>
      it === 'sep'
        ? h('div', { class: 'ctx-sep' })
        : h(
            'button',
            {
              class: it.danger ? 'danger' : '',
              disabled: !!it.disabled,
              onclick: () => {
                menu.remove();
                it.action();
              },
            },
            it.icon ? icon(it.icon, 16) : h('span', { class: 'ctx-icon-pad' }),
            it.label,
          ),
    ),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 4)}px`;
  const away = (e: Event) => {
    if (!menu.contains(e.target as Node)) {
      menu.remove();
      removeEventListener('pointerdown', away, true);
      removeEventListener('blur', away);
    }
  };
  setTimeout(() => {
    addEventListener('pointerdown', away, true);
    addEventListener('blur', away);
  });
}

let toastTimer = 0;
let toastSeq = 0;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.dataset.seq = String(++toastSeq);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), kind === 'error' ? 6000 : 2500);
}

export function busy(msg: string | null) {
  let el = document.querySelector<HTMLElement>('.busy');
  if (msg === null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = h('div', { class: 'busy' }, h('div', { class: 'spinner' }), h('span'));
    document.body.append(el);
  }
  el.querySelector('span')!.textContent = msg;
}
