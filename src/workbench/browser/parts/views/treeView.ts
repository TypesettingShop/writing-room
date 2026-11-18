import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IExtensionService } from '../../../services/extensions/common/extensions.js';

export class TreeViewPane extends Disposable {
  constructor(parent: HTMLElement, viewId: string, extensions: IExtensionService) {
    super();
    const message = parent.ownerDocument.createElement('p');
    message.className = 'tree-view-message';
    message.textContent = 'There is no data provider registered that can provide view data.';
    parent.append(message);
    this._register(toDisposable(() => message.remove()));
    void extensions.activateByEvent('onView:' + viewId).catch(console.error);
  }
}
