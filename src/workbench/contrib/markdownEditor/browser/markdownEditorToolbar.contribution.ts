import type { Command } from 'prosemirror-state';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IKeybindingRule } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import {
  MarkdownEditorBlockTypeContext, MarkdownEditorCanRedoContext, MarkdownEditorCanUndoContext, MarkdownEditorFocusContext,
  MarkdownEditorFontFamilyContext, MarkdownEditorFontSizeContext, MarkdownEditorModeContext, MarkdownEditorTextAlignContext,
  MarkdownEditorWritableContext,
} from '../common/markdownEditor.js';
import { blockStyleKey, blockStyles, parseBlockStyle, setBlockStyle } from './markdownEditorBlockStyles.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';
import { formattingPresets, setFormattingPreset } from './markdownEditorPresets.js';

const toolbar = MenuId.MarkdownEditorToolbar;
const wysiwyg = MarkdownEditorModeContext.isEqualTo('wysiwyg');
const writable = MarkdownEditorWritableContext.isEqualTo(true);
const editorFocus = ContextKeyExpr.and(MarkdownEditorFocusContext.isEqualTo(true), writable);
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

interface FormattingChoice<T> {
  readonly group: string;
  readonly order: number;
  readonly title: string;
  readonly commandId: string;
  readonly commandTitle: string;
  readonly options: readonly { readonly label: string; readonly value: T }[];
  readonly selected: (value: T) => ContextKeyExpression;
  readonly parse: (arg: unknown) => T | undefined;
  readonly createCommand: (value: T) => Command;
  readonly keybinding?: readonly Omit<IKeybindingRule, 'id'>[];
}

function registerChoice<T>(choice: FormattingChoice<T>): void {
  const { group, order, title, commandId, commandTitle, options, selected, parse, createCommand, keybinding } = choice;
  const submenu = MenuId.for(`${toolbar.id}.${commandId}`);
  MenuRegistry.appendMenuItem(toolbar, { submenu, group, order, title, when: wysiwyg, select: true });
  for (const [index, option] of options.entries()) {
    MenuRegistry.appendMenuItem(submenu, {
      order: index,
      args: [option.value],
      command: { id: commandId, title: option.label, precondition: writable, toggled: selected(option.value) },
    });
  }
  registerAction2(class extends Action2 {
    constructor() {
      super({ id: commandId, title: commandTitle, category: 'Markdown', f1: true, precondition: wysiwyg, keybinding });
    }

    override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
      const groups = accessor.get(IEditorGroupsService);
      const pane = getMarkdownPane(groups);
      const state = pane?.formattingState;
      if (!pane || !state) {
        return;
      }
      if (arg === undefined) {
        const picked = await accessor.get(IQuickInputService).pick(options, { title: `Markdown ${commandTitle}` });
        if (picked && getMarkdownPane(groups) === pane && pane.formattingState === state) {
          pane.runFormattingCommand(createCommand(picked.value));
        }
      } else {
        const value = parse(arg);
        if (value !== undefined) {
          pane.runFormattingCommand(createCommand(value));
        }
      }
    }
  });
}

function getMarkdownPane(groups: IEditorGroupsService): MarkdownEditorPane | undefined {
  const pane = groups.activeGroup?.activeEditorPane;
  return pane instanceof MarkdownEditorPane ? pane : undefined;
}

registerChoice({
  group: '2_style', order: 0, title: 'Style',
  commandId: 'markdownEditor.setBlockType', commandTitle: 'Set Block Style',
  options: blockStyles,
  selected: value => MarkdownEditorBlockTypeContext.isEqualTo(blockStyleKey(value)),
  parse: parseBlockStyle,
  createCommand: setBlockStyle,
  keybinding: blockStyles.flatMap(({ value }) => value.type === 'paragraph' || value.type === 'heading' ? [{
    primary: KeyMod.CtrlCmd | KeyMod.Alt | (KeyCode.Digit0 + (value.type === 'heading' ? value.level : 0)),
    weight: formattingWeight,
    when: editorFocus,
    args: value,
  }] : []),
});

const alignKeys = [
  ['left', KeyCode.KeyL], ['center', KeyCode.KeyE], ['right', KeyCode.KeyR], ['justify', KeyCode.KeyJ],
] as const;
for (const [axis, title, commandTitle, group, order, context] of [
  ['textAlign', 'Align', 'Set Text Alignment', '4_paragraph', 0, MarkdownEditorTextAlignContext],
  ['fontSize', 'Size', 'Set Font Size', '5_font', 0, MarkdownEditorFontSizeContext],
  ['fontFamily', 'Font', 'Set Font Family', '5_font', 1, MarkdownEditorFontFamilyContext],
] as const) {
  const { options } = formattingPresets[axis];
  registerChoice({
    group, order, title, commandTitle,
    commandId: 'markdownEditor.set' + axis[0].toUpperCase() + axis.slice(1),
    options,
    selected: value => context.isEqualTo(value),
    parse: arg => options.find(option => option.value === arg)?.value,
    createCommand: value => setFormattingPreset(axis, value),
    keybinding: axis === 'textAlign' ? alignKeys.map(([args, key]) => ({
      primary: KeyMod.CtrlCmd | KeyMod.Shift | key,
      weight: formattingWeight,
      when: editorFocus,
      args,
    })) : undefined,
  });
}
