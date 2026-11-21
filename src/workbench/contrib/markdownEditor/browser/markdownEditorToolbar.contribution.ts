import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import {
  MarkdownEditorBlockTypeContext, MarkdownEditorCanRedoContext, MarkdownEditorCanUndoContext,
  MarkdownEditorFocusContext, MarkdownEditorModeContext, MarkdownEditorWritableContext,
} from '../common/markdownEditor.js';
import { blockStyleKey, blockStyles, parseBlockStyle, setBlockStyle } from './markdownEditorBlockStyles.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';

const toolbar = MenuId.MarkdownEditorToolbar;
const wysiwyg = MarkdownEditorModeContext.isEqualTo('wysiwyg');
const writable = MarkdownEditorWritableContext.isEqualTo(true);
const editorFocus = MarkdownEditorFocusContext.isEqualTo(true);
const formattingWeight = KeybindingWeight.WorkbenchContrib + 1;

for (const [order, [id, title, icon, precondition]] of ([
  ['undo', 'Undo', 'discard', MarkdownEditorCanUndoContext.isEqualTo(true)],
  ['redo', 'Redo', 'redo', MarkdownEditorCanRedoContext.isEqualTo(true)],
] as const).entries()) {
  MenuRegistry.appendMenuItem(toolbar, {
    group: '1_history', order, when: wysiwyg,
    command: { id, title, icon: { id: icon }, precondition },
  });
}

function registerChoice<T>(
  group: string,
  order: number,
  title: string,
  commandId: string,
  options: readonly { readonly label: string; readonly value: T }[],
  selected: (value: T) => ContextKeyExpression,
): void {
  const submenu = MenuId.for(`${toolbar.id}.${commandId}`);
  MenuRegistry.appendMenuItem(toolbar, { submenu, group, order, title, when: wysiwyg, select: true });
  for (const [index, option] of options.entries()) {
    MenuRegistry.appendMenuItem(submenu, {
      order: index,
      args: [option.value],
      command: { id: commandId, title: option.label, precondition: writable, toggled: selected(option.value) },
    });
  }
}

const setBlockTypeId = 'markdownEditor.setBlockType';
registerChoice('2_style', 0, 'Style', setBlockTypeId, blockStyles, value =>
  MarkdownEditorBlockTypeContext.isEqualTo(blockStyleKey(value)));

function getMarkdownPane(groups: IEditorGroupsService): MarkdownEditorPane | undefined {
  const pane = groups.activeGroup?.activeEditorPane;
  return pane instanceof MarkdownEditorPane ? pane : undefined;
}

registerAction2(class extends Action2 {
  constructor() {
    super({
      id: setBlockTypeId,
      title: 'Set Block Style',
      category: 'Markdown',
      f1: true,
      precondition: wysiwyg,
      keybinding: blockStyles.slice(0, 7).map(({ value }, digit) => ({
        primary: KeyMod.CtrlCmd | KeyMod.Alt | (KeyCode.Digit0 + digit),
        weight: formattingWeight,
        when: editorFocus,
        args: value,
      })),
    });
  }

  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const groups = accessor.get(IEditorGroupsService);
    const pane = getMarkdownPane(groups);
    const state = pane?.formattingState;
    if (!pane || !state) {
      return;
    }
    if (arg === undefined) {
      const choice = await accessor.get(IQuickInputService).pick(blockStyles, { title: 'Markdown Block Style' });
      if (choice && getMarkdownPane(groups) === pane && pane.formattingState === state) {
        pane.runFormattingCommand(setBlockStyle(choice.value));
      }
    } else {
      const style = parseBlockStyle(arg);
      if (style) {
        pane.runFormattingCommand(setBlockStyle(style));
      }
    }
  }
});
