import { $, append } from '../../../base/browser/dom.js';
import { createWordMatcher } from '../../../base/common/filters.js';
import type { IMatch } from '../../../base/common/filters.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../common/quickInput.js';

interface QuickInputRow<T> {
  readonly item: T;
  readonly element: HTMLElement;
  readonly label: HTMLElement;
  readonly description: HTMLElement;
}

interface QuickInputGroup<T> {
  readonly element: HTMLElement;
  readonly rows: QuickInputRow<T>[];
}

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

export class QuickInputList<T extends IQuickPickItem> {
  readonly element: HTMLElement;
  private readonly groups: QuickInputGroup<T>[] = [];
  private visibleRows: QuickInputRow<T>[] = [];
  private activeIndex = -1;

  get activeItem(): T | undefined {
    return this.visibleRows[this.activeIndex]?.item;
  }

  constructor(
    id: string,
    items: readonly (T | IQuickPickSeparator)[],
    private readonly input: HTMLInputElement,
    accept: (item: T) => void,
  ) {
    this.element = $('div.wr-quick-input-list', { id, role: 'listbox', 'aria-label': 'Results' });
    let group = this.addGroup();
    for (const [index, item] of items.entries()) {
      if (item.type === 'separator') {
        group = this.addGroup(item.label);
        continue;
      }
      const label = $('span.wr-quick-input-label', null, item.label);
      const description = $('span.wr-quick-input-description', null, item.description ?? '');
      description.hidden = !item.description;
      const text = $('div.wr-quick-input-text', null, label, ' ', description);
      if (item.detail) {
        text.append($('div.wr-quick-input-detail', null, item.detail));
      }
      const element = $('div.wr-quick-input-option', { id: id + '-' + index, role: 'option', 'aria-selected': 'false' }, text);
      const shortcut = item.keybinding?.getLabel();
      if (shortcut) {
        element.append($('span.wr-quick-input-shortcut', { 'aria-hidden': 'true' }, shortcut));
        element.setAttribute('aria-description', item.keybinding?.getAriaLabel() ?? shortcut);
      }
      element.addEventListener('click', () => accept(item));
      group.rows.push({ item, element, label, description });
      group.element.append(element);
    }

    // Keep focus in the combobox until the option's click is delivered.
    this.element.addEventListener('mousedown', event => event.preventDefault());
  }

  filter(query: string): void {
    const match = createWordMatcher(query);
    this.setActive(-1);
    this.visibleRows = [];
    for (const group of this.groups) {
      let hasResults = false;
      for (const row of group.rows) {
        const description = row.item.description ?? '';
        const ranges = match(row.item.label, description);
        row.element.hidden = !ranges;
        if (ranges) {
          highlight(row.label, row.item.label, ranges[0]);
          highlight(row.description, description, ranges[1]);
          this.visibleRows.push(row);
          hasResults = true;
        }
      }
      group.element.hidden = !hasResults;
    }
    this.setActive(this.visibleRows.length ? 0 : -1);
  }

  move(direction: -1 | 1): void {
    if (this.visibleRows.length) {
      this.setActive((this.activeIndex + direction + this.visibleRows.length) % this.visibleRows.length);
    }
  }

  private addGroup(label?: string): QuickInputGroup<T> {
    const group = {
      element: append(this.element, $('div', { role: label === undefined ? 'presentation' : 'group', 'aria-label': label })),
      rows: [],
    };
    if (label !== undefined) {
      group.element.append($('div.wr-quick-input-separator', { 'aria-hidden': 'true' }, label));
    }
    this.groups.push(group);
    return group;
  }

  private setActive(index: number): void {
    this.visibleRows[this.activeIndex]?.element.setAttribute('aria-selected', 'false');
    this.activeIndex = index;
    const active = this.visibleRows[index]?.element;
    if (active) {
      active.setAttribute('aria-selected', 'true');
      this.input.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView?.({ block: 'nearest' });
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }
}
