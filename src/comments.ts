import { MessageSquare, Trash2 } from 'lucide';
import { type Annot, annotLabel, annotText, newId } from './annots';
import type { DocModel } from './model';
import { authorName } from './settings';
import { h, icon, iconButton } from './ui';

export interface CommentsActions {
  reveal(annotId: string): void;
  delete(annotId: string): void;
}

function relTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString();
}

export class CommentsPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private filter: HTMLInputElement;
  private typeFilter: HTMLSelectElement;
  visible = false;
  private stale = true;
  private active: string | null = null;
  /** Set while the panel itself edits the model, so it doesn't rebuild under the user. */
  private quiet = false;

  constructor(
    private model: DocModel,
    private actions: CommentsActions,
  ) {
    this.filter = h('input', { type: 'search', placeholder: 'Filter comments', class: 'panel-search' });
    this.typeFilter = h(
      'select',
      { class: 'panel-select', title: 'Show' },
      ...[
        ['all', 'All'],
        ['comments', 'With comments'],
        ['note', 'Notes'],
        ['markup', 'Markup'],
        ['other', 'Drawings & shapes'],
      ].map(([v, l]) => h('option', { value: v, textContent: l })),
    );
    this.filter.addEventListener('input', () => this.render(true));
    this.filter.addEventListener('keydown', (e) => e.stopPropagation());
    this.typeFilter.onchange = () => this.render(true);
    this.list = h('div', { class: 'comments-list' });
    this.el = h('div', { class: 'comments panel' }, h('div', { class: 'panel-toolbar' }, this.filter, this.typeFilter), this.list);
  }

  setActive(id: string | null) {
    this.active = id;
    this.list.querySelectorAll('.comment-card').forEach((c) => c.classList.toggle('active', (c as HTMLElement).dataset.id === id));
    if (id) this.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  invalidate() {
    if (this.quiet) return;
    this.stale = true;
    if (this.visible) requestAnimationFrame(() => this.render());
  }

  private matches(a: Annot) {
    const t = this.typeFilter.value;
    if (t === 'comments' && !(a.contents || a.replies?.length || (a.type === 'note' && a.text))) return false;
    if (t === 'note' && a.type !== 'note') return false;
    if (t === 'markup' && a.type !== 'markup') return false;
    if (t === 'other' && (a.type === 'note' || a.type === 'markup')) return false;
    const q = this.filter.value.trim().toLowerCase();
    if (!q) return true;
    const hay = [annotText(a), a.contents, a.author, ...(a.replies ?? []).map((r) => r.text)].join(' ').toLowerCase();
    return hay.includes(q);
  }

  render(force = false) {
    if (!this.visible || (!this.stale && !force)) return;
    // Don't rebuild under the user's cursor while they are typing in the panel.
    if (this.el.contains(document.activeElement) && document.activeElement?.tagName === 'TEXTAREA' && !force) return;
    this.stale = false;
    const groups: HTMLElement[] = [];
    let total = 0;
    this.model.pages.forEach((p, i) => {
      const annots = p.annots.filter((a) => a.type !== 'field' && this.matches(a));
      if (!annots.length) return;
      total += annots.length;
      groups.push(h('div', { class: 'comments-page', textContent: `Page ${i + 1}` }), ...annots.map((a) => this.card(a)));
    });
    this.list.replaceChildren(
      ...(total ? groups : [h('div', { class: 'empty' }, icon(MessageSquare, 28), h('p', { textContent: 'No comments or annotations.' }))]),
    );
    this.setActive(this.active);
  }

  private card(a: Annot) {
    const isNote = a.type === 'note';
    const body = isNote ? a.text : a.contents ?? '';
    const quote = isNote ? '' : annotText(a);
    const comment = h('textarea', { class: 'comment-text', value: body, placeholder: isNote ? 'Empty comment' : 'Add a comment…', rows: 1 });
    const grow = () => {
      comment.style.height = 'auto';
      comment.style.height = `${comment.scrollHeight}px`;
    };
    requestAnimationFrame(grow);
    comment.addEventListener('input', grow);
    comment.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && e.ctrlKey) comment.blur();
    });
    comment.addEventListener('change', () => {
      this.quiet = true;
      try {
        this.model.edit('annots', () => {
          if (a.type === 'note') a.text = comment.value.trim();
          else a.contents = comment.value.trim() || undefined;
        });
      } finally {
        this.quiet = false;
      }
    });
    const reply = h('input', { class: 'reply-input', placeholder: 'Reply…' });
    reply.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' || !reply.value.trim()) return;
      const text = reply.value.trim();
      this.model.edit('annots', () => (a.replies ??= []).push({ id: newId(), author: authorName(), date: new Date().toISOString(), text }));
      this.render(true);
    });
    const replies = (a.replies ?? []).map((r) =>
      h(
        'div',
        { class: 'reply' },
        h('div', { class: 'comment-meta' }, h('b', { textContent: r.author || 'Unknown' }), h('span', { textContent: relTime(r.date) }), iconButton(Trash2, 'Delete reply', () => this.model.edit('annots', () => (a.replies = a.replies!.filter((x) => x.id !== r.id))), 'tiny danger')),
        h('div', { class: 'reply-text', textContent: r.text }),
      ),
    );
    const card = h(
      'div',
      { class: 'comment-card', dataset: { id: a.id } },
      h(
        'div',
        { class: 'comment-meta' },
        h('span', { class: 'swatch-dot', style: `background:${a.color}` as never }),
        h('b', { textContent: a.author || 'Unknown' }),
        h('span', { textContent: `${annotLabel(a)} · ${relTime(a.date)}` }),
        iconButton(Trash2, 'Delete', () => this.actions.delete(a.id), 'tiny danger'),
      ),
      quote ? h('div', { class: 'comment-quote', textContent: quote }) : null,
      comment,
      ...replies,
      reply,
    );
    card.addEventListener('click', (e) => {
      if ((e.target as Element).closest('textarea, input, button')) return;
      this.actions.reveal(a.id);
    });
    return card;
  }
}
