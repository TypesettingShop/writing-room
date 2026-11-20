import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import type { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { quickAccessRegistry } from '../common/quickAccess.js';
import type {
  IQuickAccessController, IQuickAccessProvider, IQuickAccessProviderDescriptor, IQuickAccessRegistry,
} from '../common/quickAccess.js';
import type { IQuickInputService, IQuickPick, IQuickPickItem } from '../common/quickInput.js';

interface HelpPick extends IQuickPickItem {
  readonly prefix: string;
}

/** The provider filling the pick now, with what ends its turn. */
interface ActiveProvider {
  readonly descriptor: IQuickAccessProviderDescriptor | undefined;
  readonly store: DisposableStore;
}

/**
 * Shows one quick pick whose value picks its provider: the registered provider with the longest prefix
 * the value starts with fills it, and the help rows of every provider fill it when none does.
 */
export class QuickAccessController implements IQuickAccessController {
  private picker: IQuickPick<IQuickPickItem> | undefined;
  private active: ActiveProvider | undefined;
  private readonly instances = new Map<IQuickAccessProviderDescriptor, IQuickAccessProvider>();

  constructor(
    private readonly quickInput: Pick<IQuickInputService, 'createQuickPick'>,
    private readonly instantiation: Pick<IInstantiationService, 'createInstance'> | undefined,
    private readonly registry: IQuickAccessRegistry = quickAccessRegistry(),
  ) {}

  show(value = ''): void {
    const visible = this.picker;
    if (visible) {
      visible.value = value;
      visible.valueSelection = this.selectionFor(value);
      return;
    }

    const picker = this.quickInput.createQuickPick<IQuickPickItem>();
    this.picker = picker;
    const listeners = new DisposableStore();
    picker.value = value;
    picker.valueSelection = this.selectionFor(value);
    // The prefix is taken off once: the provider filters with the rest, and the help rows always show.
    picker.filterValue = text => {
      const descriptor = this.active?.descriptor;
      return descriptor ? text.slice(descriptor.prefix.length) : '';
    };
    listeners.add(picker.onDidChangeValue(text => this.update(picker, text)));
    listeners.add(picker.onDidHide(() => {
      if (this.picker === picker) {
        this.picker = undefined;
      }
      this.endActive();
      listeners.dispose();
      picker.dispose();
    }));
    this.update(picker, value);
    picker.show();
    if (!picker.visible) {
      // Nothing could be shown (the quick input is gone): end as a hide would.
      if (this.picker === picker) {
        this.picker = undefined;
      }
      this.endActive();
      listeners.dispose();
      picker.dispose();
    }
  }

  /** Puts the caret after a prefix that starts `value`, so typing adds to it. */
  private selectionFor(value: string): readonly [number, number] | undefined {
    const descriptor = this.registry.getQuickAccessProvider(value);
    return descriptor ? [value.length, value.length] : undefined;
  }

  private update(picker: IQuickPick<IQuickPickItem>, value: string): void {
    const descriptor = this.registry.getQuickAccessProvider(value);
    if (this.active && this.active.descriptor === descriptor) {
      // The same provider keeps its turn and follows the value itself.
      return;
    }
    this.endActive();
    const store = new DisposableStore();
    this.active = { descriptor, store };
    picker.items = [];
    picker.busy = false;
    picker.placeholder = descriptor?.placeholder;

    if (!descriptor) {
      this.showHelp(picker, store);
      return;
    }
    const source = new CancellationTokenSource();
    store.add({ dispose: () => { source.cancel(); source.dispose(); } });
    const provider = this.provider(descriptor);
    store.add(provider.provide(picker, source.token));
  }

  private showHelp(picker: IQuickPick<IQuickPickItem>, store: DisposableStore): void {
    const picks: HelpPick[] = [];
    for (const descriptor of this.registry.getQuickAccessProviders()) {
      for (const entry of descriptor.helpEntries) {
        const prefix = entry.prefix ?? descriptor.prefix;
        picks.push({ label: prefix, description: entry.description, prefix });
      }
    }
    picker.items = picks;
    store.add(picker.onDidAccept(() => {
      const [pick] = picker.selectedItems as readonly HelpPick[];
      if (pick && picks.includes(pick)) {
        picker.value = pick.prefix;
        picker.valueSelection = [pick.prefix.length, pick.prefix.length];
      }
    }));
  }

  private provider(descriptor: IQuickAccessProviderDescriptor): IQuickAccessProvider {
    let provider = this.instances.get(descriptor);
    if (!provider) {
      provider = this.instantiation ? this.instantiation.createInstance(descriptor.ctor) : new descriptor.ctor();
      this.instances.set(descriptor, provider);
    }
    return provider;
  }

  private endActive(): void {
    const active = this.active;
    this.active = undefined;
    active?.store.dispose();
  }
}
