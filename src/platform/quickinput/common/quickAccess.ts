import type { CancellationToken } from '../../../base/common/cancellation.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Registry } from '../../registry/common/platform.js';
import type { IQuickPick, IQuickPickItem } from './quickInput.js';

/** Fills the quick access pick while its value starts with the provider's prefix. */
export interface IQuickAccessProvider {
  /**
   * Fills `picker` and follows its value until the returned disposable is disposed, which happens when
   * the value leaves the prefix or the pick hides. `token` is cancelled at the same moment.
   */
  provide(picker: IQuickPick<IQuickPickItem>, token: CancellationToken): IDisposable;
}

/** A row of the help shown when no prefix matches the value. */
export interface IQuickAccessProviderHelp {
  /** The prefix the row puts in the value; the provider's own prefix when omitted. */
  readonly prefix?: string;
  readonly description: string;
}

export interface IQuickAccessProviderDescriptor {
  /** Created with the instantiation service, once per quick access controller. */
  readonly ctor: new (...services: any[]) => IQuickAccessProvider;
  readonly prefix: string;
  /** Shown in the empty field while this provider fills the pick. */
  readonly placeholder?: string;
  readonly helpEntries: readonly IQuickAccessProviderHelp[];
}

export interface IQuickAccessRegistry {
  registerQuickAccessProvider(descriptor: IQuickAccessProviderDescriptor): IDisposable;
  getQuickAccessProviders(): readonly IQuickAccessProviderDescriptor[];
  /** The provider with the longest prefix that `value` starts with. */
  getQuickAccessProvider(value: string): IQuickAccessProviderDescriptor | undefined;
}

export interface IQuickAccessController {
  /**
   * Shows the quick access pick with `value`, hiding any other quick input; when it already shows,
   * only its value changes.
   */
  show(value?: string): void;
}

export const QuickAccessExtensions = { Quickaccess: 'workbench.contributions.quickaccess' } as const;

export class QuickAccessRegistry implements IQuickAccessRegistry {
  private providers: IQuickAccessProviderDescriptor[] = [];

  registerQuickAccessProvider(descriptor: IQuickAccessProviderDescriptor): IDisposable {
    if (this.providers.some(provider => provider.prefix === descriptor.prefix)) {
      throw new Error(`A quick access provider is already registered for the prefix '${descriptor.prefix}'.`);
    }
    this.providers = [...this.providers, descriptor];
    return toDisposable(() => {
      this.providers = this.providers.filter(provider => provider !== descriptor);
    });
  }

  getQuickAccessProviders(): readonly IQuickAccessProviderDescriptor[] {
    return this.providers;
  }

  getQuickAccessProvider(value: string): IQuickAccessProviderDescriptor | undefined {
    let found: IQuickAccessProviderDescriptor | undefined;
    for (const provider of this.providers) {
      if (value.startsWith(provider.prefix) && (!found || provider.prefix.length > found.prefix.length)) {
        found = provider;
      }
    }
    return found;
  }
}

if (!Registry.knows(QuickAccessExtensions.Quickaccess)) {
  Registry.add(QuickAccessExtensions.Quickaccess, new QuickAccessRegistry());
}

export function quickAccessRegistry(): IQuickAccessRegistry {
  return Registry.as<IQuickAccessRegistry>(QuickAccessExtensions.Quickaccess)!;
}
