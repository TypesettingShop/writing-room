import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

type ItemOpener = (accessor: ServicesAccessor, itemId: string) => void | Promise<void>;
let openItem: ItemOpener | undefined;

export function registerWorldItemOpener(opener: ItemOpener): IDisposable {
  openItem = opener;
  return toDisposable(() => {
    if (openItem === opener) {
      openItem = undefined;
    }
  });
}

export function openWorldItem(accessor: ServicesAccessor, itemId: string): void | Promise<void> {
  return openItem?.(accessor, itemId);
}
