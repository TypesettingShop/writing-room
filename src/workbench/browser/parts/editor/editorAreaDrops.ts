import { Emitter } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { DraggedNavigatorItems, NavigatorDragAndDropObserver } from '../../dnd.js';

interface NavigatorDropProvider {
  readonly observer: NavigatorDragAndDropObserver;
  isForWork(accessor: ServicesAccessor, workId: string): boolean;
  hasItems(accessor: ServicesAccessor, nodeIds: readonly string[]): boolean;
  open(accessor: ServicesAccessor, nodeIds: readonly string[], group: IEditorGroup): Promise<void>;
}

export interface NavigatorEditorDrop {
  readonly kind: 'navigator';
  readonly provider: NavigatorDropProvider;
  readonly items: DraggedNavigatorItems;
}

const providers = new Map<NavigatorDragAndDropObserver, NavigatorDropProvider>();
const ended = new Emitter<void>();
export const onDidEndNavigatorDrag = ended.event;

export function registerNavigatorDropProvider(provider: NavigatorDropProvider): IDisposable {
  const { observer } = provider;
  if (providers.has(observer)) {
    throw new Error('This navigator already has an editor drop provider.');
  }
  providers.set(observer, provider);
  const listener = observer.onDidEndDrag(() => ended.fire());
  return toDisposable(() => {
    providers.delete(observer);
    observer.endDrag();
    listener.dispose();
  });
}

/** Webview frames only need to recognize the drag so the editor part can take the events. */
export function hasNavigatorDrag(event: DragEvent, target: HTMLElement): boolean {
  for (const observer of providers.keys()) {
    if (observer.getDraggedItems(event, target)) {
      return true;
    }
  }
  return false;
}

export function readNavigatorDrop(event: DragEvent, target: HTMLElement, accessor: ServicesAccessor): NavigatorEditorDrop | undefined {
  for (const provider of providers.values()) {
    const items = provider.observer.getDraggedItems(event, target);
    if (items && provider.isForWork(accessor, items.workId)) {
      return { kind: 'navigator', provider, items };
    }
  }
  return undefined;
}
