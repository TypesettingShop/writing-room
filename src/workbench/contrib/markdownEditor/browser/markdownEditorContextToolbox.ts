import type { EditorView } from 'prosemirror-view';
import type { MenuAnchor } from '../../../../base/browser/ui/menu/menu.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import type { IMenuContext } from '../../../../platform/actions/common/actions.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { markdownSelectionFormattingGroup } from '../common/markdownEditor.js';
import { pasteFromMarkdownClipboard } from './markdownEditorClipboard.js';

export function showMarkdownContextToolbox(
  accessor: ServicesAccessor, view: EditorView, context: IMenuContext, anchor: MenuAnchor, isCurrent: () => boolean,
): IDisposable | undefined {
  const menuService = accessor.get(IMenuService);
  const contextMenu = accessor.get(IContextMenuService);
  const notifications = accessor.get(INotificationService);
  const { doc, selection } = view.state;
  // A clipboard permission prompt can remain open while the user or another view edits the document.
  const isClipboardTarget = () => isCurrent() && view.hasFocus() && view.state.doc === doc && selection.eq(view.state.selection);
  const clipboardActions = ([
    ['cut', 'Cut'], ['copy', 'Copy'], ['paste', 'Paste'],
  ] as const).map(([id, label]) => ({
    id, label, run: async () => {
      if (!isClipboardTarget()) return;
      try {
        if (id === 'paste') {
          await pasteFromMarkdownClipboard(view, isClipboardTarget);
        } else if (!view.dom.ownerDocument.execCommand(id)) {
          throw new Error('Clipboard command is unavailable');
        }
      } catch {
        if (isCurrent()) notifications.warn(`Could not ${id} using the clipboard. Try the keyboard shortcut.`);
      }
    },
  }));
  return contextMenu.showContextMenu({
    label: 'Markdown selection',
    horizontalGroup: markdownSelectionFormattingGroup,
    getAnchor: () => anchor,
    getActions: () => [...menuService.getMenuActions(MenuId.MarkdownEditorSelection, context), ['clipboard', clipboardActions]],
  });
}
