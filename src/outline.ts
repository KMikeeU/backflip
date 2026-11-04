import { ArrowDown, ArrowUp, Bookmark, BookmarkPlus, ListIndentDecrease, ListIndentIncrease, Pencil, Target, Trash2 } from 'lucide';
import { newId } from './annots';
import type { DocModel, OutlineNode } from './model';
import { contextMenu, h, icon, iconButton } from './ui';

export interface OutlineActions {
  goTo(node: OutlineNode): void;
  /** Current page key and the y (PDF space) at the top of the viewport. */
  currentTarget(): { pageKey: string; y: number | null } | null;
  suggestedTitle(): string;
}

function locate(list: OutlineNode[], id: string): { list: OutlineNode[]; index: number; parent: OutlineNode | null } | null {
  const walk = (l: OutlineNode[], parent: OutlineNode | null): ReturnType<typeof locate> => {
    for (let i = 0; i < l.length; i++) {
      if (l[i].id === id) return { list: l, index: i, parent };
      const r = walk(l[i].children, l[i]);
      if (r) return r;
    }
    return null;
  };
  return walk(list, null);
}

export class OutlinePanel {
  readonly el: HTMLElement;
  private tree: HTMLElement;
  private editing: string | null = null;

  constructor(
    private model: DocModel,
    private actions: OutlineActions,
  ) {
    this.tree = h('div', { class: 'outline-tree' });
    this.el = h(
      'div',
      { class: 'outline panel' },
      h('div', { class: 'panel-toolbar' }, iconButton(BookmarkPlus, 'Add bookmark for current page (Ctrl+B)', () => this.add()), h('span', { class: 'hint', textContent: 'Right-click to edit' })),
      this.tree,
    );
  }

  private edit(fn: () => void) {
    this.model.edit('meta', () => {
      fn();
      this.model.outlineEdited = true;
    });
  }

  add(afterId?: string, asChild = false) {
    const t = this.actions.currentTarget();
    if (!t) return;
    const node: OutlineNode = { id: newId(), title: this.actions.suggestedTitle(), pageKey: t.pageKey, y: t.y, children: [], open: true };
    this.edit(() => {
      const loc = afterId ? locate(this.model.outline, afterId) : null;
      if (loc && asChild) {
        loc.list[loc.index].children.push(node);
        loc.list[loc.index].open = true;
      } else if (loc) loc.list.splice(loc.index + 1, 0, node);
      else this.model.outline.push(node);
    });
    this.editing = node.id;
    this.render();
  }

  private mutate(id: string, op: 'up' | 'down' | 'indent' | 'outdent' | 'delete' | 'retarget') {
    this.edit(() => {
      const loc = locate(this.model.outline, id);
      if (!loc) return;
      const { list, index, parent } = loc;
      const node = list[index];
      switch (op) {
        case 'up':
          if (index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
          break;
        case 'down':
          if (index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
          break;
        case 'indent':
          if (index > 0) {
            list.splice(index, 1);
            list[index - 1].children.push(node);
            list[index - 1].open = true;
          }
          break;
        case 'outdent':
          if (parent) {
            const ploc = locate(this.model.outline, parent.id)!;
            list.splice(index, 1);
            ploc.list.splice(ploc.index + 1, 0, node);
          }
          break;
        case 'delete':
          list.splice(index, 1);
          break;
        case 'retarget': {
          const t = this.actions.currentTarget();
          if (t) Object.assign(node, { pageKey: t.pageKey, y: t.y, url: null });
          break;
        }
      }
    });
  }

  private menu(node: OutlineNode, x: number, y: number) {
    contextMenu(x, y, [
      { label: 'Rename', icon: Pencil, action: () => ((this.editing = node.id), this.render()) },
      { label: 'Set to current view', icon: Target, action: () => this.mutate(node.id, 'retarget') },
      'sep',
      { label: 'Add bookmark after', icon: BookmarkPlus, action: () => this.add(node.id) },
      { label: 'Add child bookmark', icon: Bookmark, action: () => this.add(node.id, true) },
      'sep',
      { label: 'Move up', icon: ArrowUp, action: () => this.mutate(node.id, 'up') },
      { label: 'Move down', icon: ArrowDown, action: () => this.mutate(node.id, 'down') },
      { label: 'Indent', icon: ListIndentIncrease, action: () => this.mutate(node.id, 'indent') },
      { label: 'Outdent', icon: ListIndentDecrease, action: () => this.mutate(node.id, 'outdent') },
      'sep',
      { label: 'Delete', icon: Trash2, danger: true, action: () => this.mutate(node.id, 'delete') },
    ]);
  }

  render() {
    const valid = new Set(this.model.pages.map((p) => p.key));
    const build = (nodes: OutlineNode[]): HTMLElement =>
      h(
        'ul',
        {},
        ...nodes.map((n) => {
          const broken = !n.url && (!n.pageKey || !valid.has(n.pageKey));
          let label: HTMLElement;
          if (this.editing === n.id) {
            const input = h('input', { class: 'outline-rename', value: n.title });
            const commit = (save: boolean) => {
              if (this.editing !== n.id) return;
              this.editing = null;
              if (save && input.value.trim() && input.value !== n.title) this.edit(() => (n.title = input.value.trim()));
              else this.render();
            };
            input.addEventListener('keydown', (e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commit(true);
              if (e.key === 'Escape') commit(false);
            });
            input.addEventListener('blur', () => commit(true));
            label = input;
          } else {
            label = h('button', { class: `outline-item${broken ? ' broken' : ''}`, textContent: n.title || '(untitled)', title: broken ? 'Target page was deleted' : n.title });
            label.onclick = () => !broken && this.actions.goTo(n);
            label.ondblclick = () => ((this.editing = n.id), this.render());
          }
          const toggle = h('button', { class: 'outline-toggle', textContent: n.children.length ? (n.open ? '▾' : '▸') : '' });
          toggle.onclick = () => {
            n.open = !n.open;
            this.render();
          };
          const row = h('div', { class: 'outline-row' }, toggle, label);
          row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.menu(n, e.clientX, e.clientY);
          });
          return h('li', {}, row, n.children.length && n.open ? build(n.children) : null);
        }),
      );
    this.tree.replaceChildren(
      this.model.outline.length ? build(this.model.outline) : h('div', { class: 'empty' }, icon(Bookmark, 28), h('p', { textContent: 'No bookmarks yet. Add one for the current page with the button above or Ctrl+B.' })),
    );
    // Focus synchronously so the first keystrokes go to the input, not to tool shortcuts.
    const input = this.tree.querySelector<HTMLInputElement>('.outline-rename');
    if (input) {
      input.focus();
      input.select();
    }
  }
}
