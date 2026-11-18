import { renderLabelWithIcons } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { runMenuAction } from '../../../../base/browser/ui/menu/menu.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import { StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { Part } from '../../part.js';

interface Entry {
  readonly element: HTMLElement;
  readonly priority: number;
}

export class StatusbarPart extends Part implements IStatusbarService {
  declare readonly _serviceBrand: undefined;
  override readonly minimumHeight = 22;
  override readonly maximumHeight = 22;
  private readonly entries = this._register(new DisposableStore());
  private readonly groups = new Map<StatusbarAlignment, { element: HTMLElement; entries: Entry[] }>();

  constructor(@ICommandService private readonly commandService: ICommandService) {
    super(Parts.STATUSBAR_PART);
  }

  protected override createContentArea(parent: HTMLElement): void {
    for (const alignment of [StatusbarAlignment.LEFT, StatusbarAlignment.RIGHT]) {
      const element = parent.ownerDocument.createElement('div');
      element.className = 'statusbar-items';
      parent.append(element);
      this.groups.set(alignment, { element, entries: [] });
    }
  }

  addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor {
    const group = this.groups.get(alignment)!;
    const document = group.element.ownerDocument;
    const element = document.createElement('div');
    element.className = 'statusbar-item';
    element.dataset.entryId = id;

    let current = entry;
    const item = { element, priority };
    const next = group.entries.findIndex(other => other.priority < priority);
    group.element.insertBefore(element, group.entries[next]?.element ?? null);
    group.entries.splice(next === -1 ? group.entries.length : next, 0, item);

    const store = this.entries.add(new DisposableStore());
    let label: HTMLButtonElement | HTMLSpanElement | undefined;
    const update = (value: IStatusbarEntry) => {
      if (store.isDisposed) {
        return;
      }
      current = value;
      const tag = current.command ? 'BUTTON' : 'SPAN';
      if (label?.tagName !== tag) {
        label = document.createElement(tag === 'BUTTON' ? 'button' : 'span');
        if (label instanceof HTMLButtonElement) {
          label.type = 'button';
        }
        element.replaceChildren(label);
      }
      label.setAttribute('aria-label', current.ariaLabel ?? current.name);
      label.title = current.tooltip ?? '';
      label.replaceChildren(...renderLabelWithIcons(current.text));
    };
    store.add(addDisposableListener(element, 'click', () => {
      const command = current.command;
      if (command) {
        const id = typeof command === 'string' ? command : command.id;
        const args = typeof command === 'string' ? [] : command.arguments ?? [];
        void runMenuAction({ id, label: current.name, run: () => this.commandService.executeCommand(id, ...args) });
      }
    }));
    store.add(toDisposable(() => {
      group.entries.splice(group.entries.indexOf(item), 1);
      element.remove();
    }));
    update(entry);
    return { update, dispose: () => this.entries.delete(store) };
  }
}
