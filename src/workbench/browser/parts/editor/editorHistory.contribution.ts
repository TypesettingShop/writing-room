import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { InputFocusedContext } from '../../../../platform/contextkey/common/contextkeys.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { CONTEXT_ACTIVE_CUSTOM_EDITOR_ID } from '../../../contrib/customEditor/common/customEditor.js';
import { MarkdownEditorPane } from '../../../contrib/markdownEditor/browser/markdownEditorPane.js';
import {
  MarkdownEditorCanRedoContext, MarkdownEditorCanUndoContext, MarkdownEditorModeContext,
} from '../../../contrib/markdownEditor/common/markdownEditor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';

const markdownActive = MarkdownEditorModeContext.isEqualTo('wysiwyg');
const customActive = ContextKeyExpr.has(CONTEXT_ACTIVE_CUSTOM_EDITOR_ID.key);

class EditorHistoryContext extends Disposable {
  constructor(
    @IEditorGroupsService groups: IEditorGroupsService,
    @IContextKeyService contextKeys: IContextKeyService,
  ) {
    super();
    const undo = MarkdownEditorCanUndoContext.bindTo(contextKeys);
    const redo = MarkdownEditorCanRedoContext.bindTo(contextKeys);
    const listener = this._register(new MutableDisposable());
    const bindActivePane = () => {
      const active = groups.activeGroup?.activeEditorPane;
      const pane = active instanceof MarkdownEditorPane ? active : undefined;
      const update = () => {
        undo.set(pane?.canUndo ?? false);
        redo.set(pane?.canRedo ?? false);
      };
      listener.value = pane?.onDidChangeHistory(update);
      update();
    };
    this._register(groups.onDidActiveEditorChange(bindActivePane));
    bindActivePane();
  }
}

registerWorkbenchContribution2('workbench.contrib.editorHistoryContext', EditorHistoryContext);

const workbenchHistoryKeys = ContextKeyExpr.or(
  ContextKeyExpr.and(customActive, ContextKeyExpr.not('editorTextFocus'), ContextKeyExpr.not('textInputFocus')),
  ContextKeyExpr.and(markdownActive, InputFocusedContext.toNegated()),
);

/** One command per operation so Markdown and Custom Editors can coexist. Monaco handles its own keys. */
for (const [id, title, enabled, keys] of [
  ['undo', 'Undo', MarkdownEditorCanUndoContext, { primary: KeyMod.CtrlCmd | KeyCode.KeyZ }],
  ['redo', 'Redo', MarkdownEditorCanRedoContext, {
    primary: KeyMod.CtrlCmd | KeyCode.KeyY,
    secondary: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ],
    mac: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyZ },
  }],
] as const) {
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, category: 'Edit', f1: true,
        precondition: ContextKeyExpr.or(customActive, ContextKeyExpr.has(enabled.key)),
        menu: { id: MenuId.MenubarEditMenu, when: markdownActive, group: '1_history', order: id === 'undo' ? 1 : 2 },
        keybinding: { ...keys, weight: KeybindingWeight.WorkbenchContrib, when: workbenchHistoryKeys },
      });
    }

    override async run(accessor: ServicesAccessor): Promise<void> {
      const group = accessor.get(IEditorGroupsService).activeGroup;
      const editor = group.activeEditor;
      const pane = group.activeEditorPane;
      if (pane instanceof MarkdownEditorPane) {
        id === 'undo' ? pane.undo() : pane.redo();
      } else if (editor instanceof CustomEditorInput) {
        await (id === 'undo' ? editor.undo() : editor.redo());
      }
    }
  });
}
