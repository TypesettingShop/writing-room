import { $, addDisposableListener } from '../../../base/browser/dom.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { createWordMatcher } from '../../../base/common/filters.js';
import type { IMatch } from '../../../base/common/filters.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';

interface QuickInputRow {
  readonly element: HTMLElement;
  readonly label: HTMLElement;
  readonly description: HTMLElement;
  readonly detail: HTMLElement | undefined;
}

interface Entry<T> {
  readonly item: T;
  readonly index: number;
  readonly group: number;
}

interface Highlights {
  readonly label: readonly IMatch[];
  readonly description: readonly IMatch[];
  readonly detail: readonly IMatch[];
}

interface Result<T> extends Entry<T> {
  readonly highlights: Highlights | undefined;
}

export interface IFilterOptions {
  readonly matchOnDescription: boolean;
  readonly matchOnDetail: boolean;
}

/** Rows are created as they come into reach, so a list of many thousands of items opens at once. */
const pageSize = 200;

function highlight(element: HTMLElement, value: string, ranges: readonly IMatch[]): void {
  if (ranges.length === 0 && element.childElementCount === 0 && element.textContent === value) {
    return;
  }
  const contents: (string | HTMLElement)[] = [];
  let end = 0;
  for (const match of ranges) {
    contents.push(value.slice(end, match.start), $('mark', null, value.slice(match.start, match.end)));
    end = match.end;
  }
  contents.push(value.slice(end));
  element.replaceChildren(...contents);
}

export class QuickInputList<T extends IQuickPickItem> extends Disposable {
  readonly element: HTMLElement;
  private entries: Entry<T>[] = [];
  private groups: { readonly label: string | undefined; element?: HTMLElement }[] = [];
  private rows = new Map<T, QuickInputRow>();
  private results: Result<T>[] = [];
  private rendered = 0;
  private activeIndex = -1;
  private checked = new Set<T>();
  private canSelectMany = false;

  private readonly didChangeActive = this._register(new Emitter<T | undefined>());
  /** The highlighted row changed, by a key, a filter or new items. */
  readonly onDidChangeActive = this.didChangeActive.event;
  private readonly didPress = this._register(new Emitter<T>());
  /** A row was clicked. */
  readonly onDidPress = this.didPress.event;

  get activeItem(): T | undefined {
    return this.results[this.activeIndex]?.item;
  }

  get checkedItems(): T[] {
    return this.entries.filter(entry => this.checked.has(entry.item)).map(entry => entry.item);
  }

  constructor(private readonly id: string, private readonly input: HTMLInputElement) {
    super();
    this.element = $('div.wr-quick-input-list', { id, role: 'listbox', 'aria-label': 'Results' });
    this._register(addDisposableListener(this.element, 'scroll', () => {
      if (this.element.scrollTop + this.element.clientHeight >= this.element.scrollHeight - 64) {
        this.renderUpTo(this.rendered + pageSize);
      }
    }, { passive: true }));
  }

  /** Replaces the items. Call `filter` afterwards. */
  setItems(items: readonly (T | IQuickPickSeparator)[]): void {
    this.entries = [];
    this.groups = [{ label: undefined }];
    for (const [index, item] of items.entries()) {
      if (item.type === 'separator') {
        this.groups.push({ label: typeof item.label === 'string' ? item.label : '' });
      } else {
        this.entries.push({ item, index, group: this.groups.length - 1 });
      }
    }
    this.rows = new Map();
    const present = new Set(this.entries.map(entry => entry.item));
    this.checked = new Set([...this.checked].filter(item => present.has(item)));
  }

  setCanSelectMany(value: boolean): void {
    if (this.canSelectMany !== value) {
      this.canSelectMany = value;
      this.rows = new Map();
      this.rerender();
    }
  }

  setChecked(items: readonly T[]): void {
    this.checked = new Set(items);
    for (const [item, row] of this.rows) {
      this.updateChecked(item, row);
    }
  }

  toggle(item: T): void {
    if (this.checked.has(item)) {
      this.checked.delete(item);
    } else {
      this.checked.add(item);
    }
    const row = this.rows.get(item);
    if (row) {
      this.updateChecked(item, row);
    }
  }

  /**
   * Shows the items that match `query` and highlights `preferred` when it is shown, or else the first
   * one. `alwaysShow` items are shown whatever the query is.
   */
  filter(query: string, options: IFilterOptions, preferred: T | undefined): void {
    const match = createWordMatcher(query);
    const empty = !query.trim();
    this.results = [];
    for (const entry of this.entries) {
      const { item } = entry;
      const fields = [item.label, ...options.matchOnDescription ? [item.description ?? ''] : [],
        ...options.matchOnDetail ? [item.detail ?? ''] : []];
      const ranges = empty ? undefined : match(...fields);
      if (empty || ranges || item.alwaysShow) {
        let next = 1;
        const highlights = ranges && {
          label: ranges[0],
          description: options.matchOnDescription ? ranges[next++] : [],
          detail: options.matchOnDetail ? ranges[next] : [],
        };
        this.results.push({ ...entry, highlights });
      }
    }
    const kept = preferred === undefined ? -1 : this.results.findIndex(result => result.item === preferred);
    this.rerender();
    this.setActive(kept !== -1 ? kept : this.results.length ? 0 : -1, false);
  }

  /** Highlights `item` if it is shown. */
  activate(item: T | undefined): void {
    const index = item === undefined ? -1 : this.results.findIndex(result => result.item === item);
    if (index !== -1 || item === undefined) {
      this.setActive(index, false);
    }
  }

  move(direction: number): void {
    const count = this.results.length;
    if (!count) {
      return;
    }
    let next = this.activeIndex + direction;
    if (Math.abs(direction) === 1) {
      next = (next + count) % count;
    } else {
      next = Math.max(0, Math.min(count - 1, next));
    }
    this.setActive(next, true);
  }

  private rerender(): void {
    this.rendered = 0;
    for (const group of this.groups) {
      group.element?.remove();
      if (group.element) {
        group.element.replaceChildren(...group.label === undefined ? [] : [group.element.firstChild!]);
      }
    }
    this.element.replaceChildren();
    this.renderUpTo(Math.max(pageSize, this.activeIndex + 1));
  }

  private renderUpTo(limit: number): void {
    const end = Math.min(limit, this.results.length);
    for (; this.rendered < end; this.rendered++) {
      const result = this.results[this.rendered];
      const group = this.groupElement(result.group);
      if (group.parentElement !== this.element) {
        this.element.append(group);
      }
      const row = this.row(result.item, result.index);
      const { item, highlights } = result;
      highlight(row.label, item.label, highlights?.label ?? []);
      highlight(row.description, item.description ?? '', highlights?.description ?? []);
      if (row.detail) {
        highlight(row.detail, item.detail ?? '', highlights?.detail ?? []);
      }
      row.element.setAttribute('aria-posinset', String(this.rendered + 1));
      row.element.setAttribute('aria-setsize', String(this.results.length));
      group.append(row.element);
    }
  }

  private groupElement(index: number): HTMLElement {
    const group = this.groups[index];
    if (!group.element) {
      group.element = $('div', { role: group.label === undefined ? 'presentation' : 'group', 'aria-label': group.label });
      if (group.label !== undefined) {
        group.element.append($('div.wr-quick-input-separator', { 'aria-hidden': 'true' }, group.label));
      }
    }
    return group.element;
  }

  private row(item: T, index: number): QuickInputRow {
    let row = this.rows.get(item);
    if (row) {
      return row;
    }
    const label = $('span.wr-quick-input-label');
    const description = $('span.wr-quick-input-description');
    description.hidden = !item.description;
    const text = $('div.wr-quick-input-text', null, label, ' ', description);
    let detail: HTMLElement | undefined;
    if (item.detail) {
      detail = $('div.wr-quick-input-detail');
      text.append(detail);
    }
    const element = $('div.wr-quick-input-option', { id: this.id + '-' + index, role: 'option', 'aria-selected': 'false' });
    if (this.canSelectMany) {
      element.append($('span.wr-quick-input-check.codicon.codicon-check', { 'aria-hidden': 'true' }));
    }
    element.append(text);
    const shortcut = item.keybinding?.getLabel();
    if (shortcut) {
      element.append($('span.wr-quick-input-shortcut', { 'aria-hidden': 'true' }, shortcut));
      element.setAttribute('aria-description', item.keybinding?.getAriaLabel() ?? shortcut);
    }
    element.addEventListener('click', () => this.didPress.fire(item));
    row = { element, label, description, detail };
    this.rows.set(item, row);
    this.updateChecked(item, row);
    if (this.results[this.activeIndex]?.item === item) {
      element.setAttribute('aria-selected', 'true');
    }
    return row;
  }

  private updateChecked(item: T, row: QuickInputRow): void {
    if (this.canSelectMany) {
      row.element.setAttribute('aria-checked', String(this.checked.has(item)));
    } else {
      row.element.removeAttribute('aria-checked');
    }
  }

  private setActive(index: number, reveal: boolean): void {
    const previous = this.results[this.activeIndex]?.item;
    if (previous !== undefined) {
      this.rows.get(previous)?.element.setAttribute('aria-selected', 'false');
    }
    this.activeIndex = index;
    if (index >= this.rendered) {
      this.renderUpTo(index + pageSize);
    }
    const item = this.results[index]?.item;
    const active = item === undefined ? undefined : this.rows.get(item)?.element;
    if (active) {
      active.setAttribute('aria-selected', 'true');
      this.input.setAttribute('aria-activedescendant', active.id);
      if (reveal || index === 0) {
        active.scrollIntoView?.({ block: 'nearest' });
      }
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
    if (item !== previous) {
      this.didChangeActive.fire(item);
    }
  }
}
