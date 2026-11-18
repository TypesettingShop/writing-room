import { commandTitle, IMenuService, MenuId, MenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { getQuickInputFocus } from '../../../../platform/quickinput/browser/quickInputController.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

const historyKey = 'commandPalette.mru.cache';
const historyLimit = 50;

interface CommandPick extends IQuickPickItem {
  readonly id: string;
  readonly action: MenuItemAction;
}

export class CommandsQuickAccessProvider {
  constructor(
    @IMenuService private readonly menus: IMenuService,
    @IContextKeyService private readonly contextKeys: IContextKeyService,
    @ILayoutService private readonly layout: ILayoutService,
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @IStorageService private readonly storage: IStorageService,
  ) {}

  async show(): Promise<void> {
    const focused = getQuickInputFocus(this.layout.mainContainer.ownerDocument);
    const context = this.contextKeys.getScopedContextKeyService(focused ?? null);
    const candidates = new Map<string, CommandPick>();
    for (const [, actions] of this.menus.getMenuActions(MenuId.CommandPalette, context)) {
      for (const action of actions) {
        if (!(action instanceof MenuItemAction) || !action.enabled || candidates.has(action.id)) {
          continue;
        }
        const { category } = action.item;
        const label = category ? commandTitle(category) + ': ' + action.label : action.label;
        candidates.set(action.id, { id: action.id, label, keybinding: action.keybinding, action });
      }
    }
    const recent: CommandPick[] = [];
    for (const id of this.readHistory()) {
      const candidate = candidates.get(id);
      if (candidate) {
        recent.push(candidate);
        candidates.delete(id);
      }
    }
    const remaining = [...candidates.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    const picks: (CommandPick | IQuickPickSeparator)[] = [];
    if (recent.length) {
      picks.push({ type: 'separator', label: 'Recently Used' }, ...recent);
    }
    if (recent.length && remaining.length) {
      picks.push({ type: 'separator', label: 'Other Commands' });
    }
    picks.push(...remaining);

    const picked = await this.quickInput.pick(picks, { placeHolder: 'Type a command' });
    if (picked) {
      const history = [picked.id, ...this.readHistory().filter(id => id !== picked.id)].slice(0, historyLimit);
      this.storage.store(historyKey, history, StorageScope.PROFILE, StorageTarget.USER);
      try {
        await picked.action.run();
      } catch (error) {
        console.error('Could not run command ' + picked.id, error);
      }
    }
  }

  private readHistory(): string[] {
    const raw = this.storage.get(historyKey, StorageScope.PROFILE);
    if (!raw) {
      return [];
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(value)) {
      return [];
    }

    // Contributions can register after the palette first reads its history.
    const history = new Set<string>();
    for (const id of value) {
      if (typeof id === 'string' && id.length > 0) {
        history.add(id);
        if (history.size === historyLimit) {
          break;
        }
      }
    }
    return [...history];
  }
}
