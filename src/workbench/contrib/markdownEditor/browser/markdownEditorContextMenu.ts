import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import type { MenuAction, MenuAnchor } from '../../../../base/browser/ui/menu/menu.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { formatKeybinding } from '../../../../base/common/keybindingLabels.js';
import { decodeKeybinding, getKeybindingPlatform } from '../../../../base/common/keybindings.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { IMenuService, MenuId } from '../../../../platform/actions/common/actions.js';
import type { IMenuContext } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { markdownSelectionFormattingGroup } from '../common/markdownEditor.js';
import { markdownGutterCaretTransaction, syncReadOnlyMarkdownSelection } from './markdownEditorGutter.js';

// These keys retain the browser's trusted clipboard events. The command IDs also let
// the menu offer the same operations when no native keyboard event is available.
export const markdownClipboardCommands = [
  { id: 'markdownEditor.cut', operation: 'cut', label: 'Cut', key: KeyMod.CtrlCmd | KeyCode.KeyX },
  { id: 'markdownEditor.copy', operation: 'copy', label: 'Copy', key: KeyMod.CtrlCmd | KeyCode.KeyC },
  { id: 'markdownEditor.paste', operation: 'paste', label: 'Paste', key: KeyMod.CtrlCmd | KeyCode.KeyV },
  { id: 'markdownEditor.pastePlainText', operation: 'pastePlainText', label: 'Paste as Plain Text', key: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyV },
] as const;

export type MarkdownClipboardOperation = (typeof markdownClipboardCommands)[number]['operation'];
export const MARKDOWN_SELECT_ALL_COMMAND = 'markdownEditor.selectAll';

export function getReadOnlyMarkdownSelection(view: EditorView): globalThis.Selection | undefined {
  const selection = view.dom.ownerDocument.getSelection();
  if (selection && view.dom.contains(selection.anchorNode) && view.dom.contains(selection.focusNode)) return selection;
  return undefined;
}

export function isOverMarkdownSelection(view: EditorView, { target, clientX, clientY }: MouseEvent): boolean {
  const { selection } = view.state;
  const readOnly = view.editable ? undefined : getReadOnlyMarkdownSelection(view);
  if (view.editable ? selection.empty : !readOnly || readOnly.isCollapsed) return false;

  if (view.editable && selection instanceof CellSelection) {
    return target instanceof Element && Boolean(target.closest('.selectedCell'));
  }
  if (view.editable && selection instanceof NodeSelection) {
    return target instanceof Node && view.nodeDOM(selection.from)?.contains(target) === true;
  }
  // A document position can round to either edge of a selection. Use its rendered rectangles.
  const range = readOnly?.getRangeAt(0) ?? view.dom.ownerDocument.createRange();
  if (!readOnly) {
    const start = view.domAtPos(selection.from, 1);
    const end = view.domAtPos(selection.to, -1);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
  }
  return Array.from(range.getClientRects()).some(rect => rect.width > 0 &&
    clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom);
}

export function setMarkdownContextSelection(
  surface: HTMLElement, view: EditorView, event: MouseEvent, hit: ReturnType<EditorView['posAtCoords']>,
): void {
  const { doc, schema, selection } = view.state;
  const gutter = markdownGutterCaretTransaction(surface, view, event);
  if (gutter) {
    if (gutter.docChanged || !selection.eq(gutter.selection)) view.dispatch(gutter);
    if (!view.editable) syncReadOnlyMarkdownSelection(view);
    return;
  }
  const inside = hit?.inside ?? -1;
  const node = view.editable && inside >= 0 ? doc.nodeAt(inside) : null;
  if (node && node.type === schema.nodes.image && NodeSelection.isSelectable(node)) {
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, inside)).setMeta('pointer', true));
    return;
  }
  const at = doc.resolve(hit?.pos ?? selection.head);
  const next = event.clientY < view.dom.getBoundingClientRect().top ? Selection.atStart(doc) : TextSelection.between(at, at);
  if (!view.editable) {
    // A read-only view only syncs a native selection that is already inside it, so place that one first.
    const { node, offset } = view.domAtPos(next.head);
    view.dom.ownerDocument.getSelection()?.collapse(node, offset);
  }
  // Keep a caret already at the hit position and preserve its pending marks. Without the pointer flag, a
  // read-only view would adopt the native caret later as a plain selection, and typewriter centering would
  // scroll the surface and close the menu.
  if (!selection.eq(next)) view.dispatch(view.state.tr.setSelection(next).setMeta('pointer', true));
}

export function showMarkdownContextMenu(
  accessor: ServicesAccessor, view: EditorView, context: IMenuContext, anchor: MenuAnchor,
  history: { readonly canUndo: boolean; readonly canRedo: boolean }, isCurrent: () => boolean,
): IDisposable | undefined {
  const menus = accessor.get(IMenuService);
  const contextMenu = accessor.get(IContextMenuService);
  const commands = accessor.get(ICommandService);
  const keybindings = accessor.get(IKeybindingService);
  const { selection } = view.state;
  const selected = view.editable ? !selection.empty : getReadOnlyMarkdownSelection(view)?.isCollapsed === false;
  const platform = getKeybindingPlatform(view.dom.ownerDocument.defaultView!.navigator.platform);
  const action = (id: string, label: string, enabled: boolean, nativeKey?: number): MenuAction => {
    const binding = nativeKey === undefined ? undefined : decodeKeybinding(nativeKey, platform);
    return {
      id, label, enabled,
      keybinding: keybindings.lookupKeybinding(id) ?? (binding && {
        getLabel: () => formatKeybinding(binding, platform),
        getAriaLabel: () => formatKeybinding(binding, platform, true),
      }),
      run: () => {
        if (isCurrent() && view.hasFocus()) return commands.executeCommand(id);
      },
    };
  };

  const canFormat = view.editable && !(selection instanceof NodeSelection);
  const formatting = selected
    ? menus.getMenuActions(MenuId.MarkdownEditorSelection, context).map(([group, actions]) =>
      [group, canFormat ? actions : actions.map(action => ({ ...action, enabled: false }))] as const)
    : [];
  return contextMenu.showContextMenu({
    label: 'Markdown editor',
    horizontalGroup: markdownSelectionFormattingGroup,
    getAnchor: () => anchor,
    getActions: () => [
      ...formatting,
      ['history', [action('undo', 'Undo', history.canUndo), action('redo', 'Redo', history.canRedo)]],
      ['clipboard', markdownClipboardCommands.map(({ id, operation, label, key }) => action(id, label,
        operation === 'copy' ? selected : view.editable && (operation !== 'cut' || selected), key))],
      ['selection', [action(MARKDOWN_SELECT_ALL_COMMAND, 'Select All', true)]],
    ],
  });
}
