import { expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import { ManuscriptDragAndDropObserver } from '../../../../browser/dnd.js';
import type { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import '../../../manuscript/browser/manuscriptOpener.js';
import type { IWebviewService } from '../../browser/webview.js';
import { WebviewOverlay } from '../../browser/webviewOverlay.js';

test('allows a manuscript drag to pass through an open webview and restores pointer events afterward', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const root = document.body.appendChild(document.createElement('div'));
  const anchor = root.appendChild(document.createElement('div'));
  const source = root.appendChild(document.createElement('div'));
  const frame = document.createElement('iframe');
  const webviews = {
    createElement: () => ({
      container: frame, setState() {}, setContent() {}, dispose: () => frame.remove(),
      onDidLoadContent: Event.None, onDidReceiveMessage: Event.None, onDidChangeState: Event.None, onDidRequestContextMenu: Event.None,
    }),
  } as unknown as IWebviewService;
  const layout = { mainContainer: root, onDidChangePartVisibility: Event.None } as unknown as IWorkbenchLayoutService;
  const overlay = new WebviewOverlay('test', { origin: 'http://localhost' }, false, webviews, layout,
    {} as IContextKeyService, {} as IMenuService, {} as IContextMenuService);
  const observer = ManuscriptDragAndDropObserver.INSTANCE;
  try {
    overlay.show(anchor);
    const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
    const types: string[] = [];
    Object.defineProperty(event, 'dataTransfer', { value: { types, setData: (type: string) => types.push(type) } });
    source.addEventListener('dragstart', event => observer.startDrag(event, source, { workId: 'work', nodeIds: ['node'] }));
    source.dispatchEvent(event);
    expect(frame.style.pointerEvents).toBe('none');
    observer.endDrag();
    expect(frame.style.pointerEvents).toBe('');
  } finally {
    observer.endDrag();
    overlay.dispose();
    root.remove();
    vi.unstubAllGlobals();
  }
});
