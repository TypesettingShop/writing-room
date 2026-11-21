import { markdownSchema } from '../../../../editor/common/markdown/schema.js';
import { TextSelection } from 'prosemirror-state';
import type { Command } from 'prosemirror-state';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { IMenuSelectFallback } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { IKeybindingRule } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import {
  isMarkdownContentWidth, MARKDOWN_EDITOR_CONTENT_LAYOUT, MARKDOWN_EDITOR_CONTENT_WIDTH, markdownContentWidth,
  MarkdownEditorContentLayoutContext, MarkdownEditorContentWidthContext,
  MarkdownEditorBlockTypeContext, MarkdownEditorCanRedoContext, MarkdownEditorCanUndoContext, MarkdownEditorFocusContext,
  MarkdownEditorFontFamilyContext, MarkdownEditorFontSizeContext, MarkdownEditorInlineFormattingContext,
  MarkdownEditorInlineMarkContexts, MarkdownEditorLinkContext, MarkdownEditorModeContext,
  MarkdownEditorTextAlignContext, MarkdownEditorWritableContext,
} from '../common/markdownEditor.js';
import { blockStyleKey, blockStyles, parseBlockStyle, setBlockStyle } from './markdownEditorBlockStyles.js';
import { linkAtSelection, normalizeMarkdownLink, setMarkdownLink, toggleInlineFormat } from './markdownEditorInline.js';
import { selectedMarkdownImage, setMarkdownImage } from './markdownEditorImages.js';
import { setMarkdownList } from './markdownEditorLists.js';
import { editMarkdownTable, insertMarkdownTable } from './markdownEditorTables.js';
import { MarkdownEditorPane } from './markdownEditorPane.js';
import { formattingPresets, setFormattingPreset } from './markdownEditorPresets.js';

const toolbar = MenuId.MarkdownEditorToolbar;
const wysiwyg = MarkdownEditorModeContext.isEqualTo('wysiwyg');
const writable = MarkdownEditorWritableContext.isEqualTo(true);
const editorFocus = ContextKeyExpr.and(MarkdownEditorFocusContext.isEqualTo(true), writable);
const formattingWeight = KeybindingWeight.WorkbenchContrib + 1;

const setContentWidthId = 'markdownEditor.setContentWidth';
// Only plain decimal digits: Number() alone would also take '0x3c' or '6e1' as 60.
const parseContentWidth = (text: string) => /^\d+$/.test(text.trim()) ? Number(text) : NaN;
MenuRegistry.appendMenuItem(toolbar, {
  group: '7_layout', order: 2, when: wysiwyg,
  command: {
    id: setContentWidthId, title: 'Content Width (characters)',
    precondition: MarkdownEditorContentLayoutContext.isEqualTo('center'),
  },
  numberInput: { valueKey: MarkdownEditorContentWidthContext.key, min: markdownContentWidth.min, max: markdownContentWidth.max },
});
registerAction2(class extends Action2 {
  constructor() {
    super({ id: setContentWidthId, title: 'Set Content Width', category: 'Markdown', f1: true, precondition: wysiwyg });
  }

  override async run(accessor: ServicesAccessor, value?: unknown): Promise<void> {
    const configuration = accessor.get(IConfigurationService);
    if (value === undefined) {
      const current = configuration.getValue(MARKDOWN_EDITOR_CONTENT_WIDTH);
      const input = await accessor.get(IQuickInputService).input({
        title: 'Set Content Width',
        value: String(isMarkdownContentWidth(current) ? current : markdownContentWidth.defaultValue),
        validateInput: text => isMarkdownContentWidth(parseContentWidth(text))
          ? undefined : `Enter a whole number from ${markdownContentWidth.min} to ${markdownContentWidth.max}.`,
      });
      value = input === undefined ? undefined : parseContentWidth(input);
    }
    if (isMarkdownContentWidth(value)) {
      await configuration.updateValue(MARKDOWN_EDITOR_CONTENT_WIDTH, value);
    }
  }
});

for (const [order, [layout, id, title, icon]] of ([
  ['center', 'markdownEditor.centerContent', 'Center Content', 'layout-centered'],
  ['fill', 'markdownEditor.fillContent', 'Fill Editor Width', 'layout-panel-justify'],
] as const).entries()) {
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, category: 'Markdown', icon: { id: icon }, f1: true, precondition: wysiwyg,
        toggled: MarkdownEditorContentLayoutContext.isEqualTo(layout), menu: { id: toolbar, group: '7_layout', order, when: wysiwyg },
      });
    }

    override run(accessor: ServicesAccessor): Promise<void> {
      return accessor.get(IConfigurationService).updateValue(MARKDOWN_EDITOR_CONTENT_LAYOUT, layout);
    }
  });
}

for (const [order, [id, title, icon, precondition]] of ([
  ['undo', 'Undo', 'discard', MarkdownEditorCanUndoContext.isEqualTo(true)],
  ['redo', 'Redo', 'redo', MarkdownEditorCanRedoContext.isEqualTo(true)],
] as const).entries()) {
  MenuRegistry.appendMenuItem(toolbar, {
    group: '1_history', order, when: wysiwyg,
    command: { id, title, icon: { id: icon }, precondition },
  });
}

interface FormattingPicker<T> {
  readonly commandId: string;
  readonly commandTitle: string;
  readonly options: readonly { readonly label: string; readonly value: T; readonly labelClass?: string }[];
  readonly parse: (arg: unknown) => T | undefined;
  readonly createCommand: (value: T) => Command;
  readonly keybinding?: readonly Omit<IKeybindingRule, 'id'>[];
}

interface FormattingChoice<T> extends FormattingPicker<T> {
  readonly group: string;
  readonly order: number;
  readonly title: string;
  readonly selectFallback?: readonly IMenuSelectFallback[];
  readonly selected: (value: T) => ContextKeyExpression;
}

function registerChoice<T>(choice: FormattingChoice<T>): void {
  const { group, order, title, commandId, options, selected, selectFallback } = choice;
  const submenu = MenuId.for(`${toolbar.id}.${commandId}`);
  MenuRegistry.appendMenuItem(toolbar, { submenu, group, order, title, when: wysiwyg, select: true, selectFallback });
  for (const [index, option] of options.entries()) {
    MenuRegistry.appendMenuItem(submenu, {
      order: index,
      args: [option.value],
      command: {
        id: commandId, title: option.label, labelClass: option.labelClass, precondition: writable, toggled: selected(option.value),
      },
    });
  }
  registerFormattingPicker(choice);
}

function registerFormattingPicker<T>({ commandId, commandTitle, options, parse, createCommand, keybinding }: FormattingPicker<T>): void {
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

const alignments = formattingPresets.textAlign.options.filter(option => !option.readOnly);
registerFormattingPicker({
  commandId: 'markdownEditor.setTextAlign', commandTitle: 'Set Text Alignment', options: alignments,
  parse: arg => alignments.find(option => option.value === arg)?.value,
  createCommand: value => setFormattingPreset('textAlign', value),
});
for (const [order, [value, id, title, key]] of ([
  ['left', 'markdownEditor.alignLeft', 'Align Left', KeyCode.KeyL],
  ['center', 'markdownEditor.alignCenter', 'Align Center', KeyCode.KeyE],
  ['right', 'markdownEditor.alignRight', 'Align Right', KeyCode.KeyR],
] as const).entries()) {
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, category: 'Markdown', f1: true, precondition: ContextKeyExpr.and(wysiwyg, writable),
        menu: { id: toolbar, group: '4_paragraph', order, when: wysiwyg },
        toggled: MarkdownEditorTextAlignContext.isEqualTo(value),
        keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Shift | key, weight: formattingWeight, when: editorFocus },
      });
    }

    override run(accessor: ServicesAccessor): void {
      getMarkdownPane(accessor.get(IEditorGroupsService))?.runFormattingCommand(setFormattingPreset('textAlign', value));
    }
  });
}

for (const [axis, title, commandTitle, group, order, context] of [
  ['fontSize', 'Size', 'Set Font Size', '5_font', 0, MarkdownEditorFontSizeContext],
  ['fontFamily', 'Font', 'Set Font Family', '5_font', 1, MarkdownEditorFontFamilyContext],
] as const) {
  const { options } = formattingPresets[axis];
  registerChoice({
    group, order, title, commandTitle,
    commandId: 'markdownEditor.set' + axis[0].toUpperCase() + axis.slice(1),
    options: options.filter(option => !option.hidden).map(option => ({
      label: option.label, value: option.value, labelClass: axis === 'fontFamily' ? option.className : undefined,
    })),
    // Legacy classes stay readable without a menu entry; a mixed selection (null) keeps the dash.
    selectFallback: options.filter(option => option.hidden).map(option => ({
      label: axis === 'fontSize' ? 'Custom' : option.label, when: context.isEqualTo(option.value),
    })),
    selected: value => context.isEqualTo(value),
    parse: arg => options.find(option => option.value === arg)?.value,
    createCommand: value => setFormattingPreset(axis, value),
  });
}

const inline = MarkdownEditorInlineFormattingContext.isEqualTo(true);
const inlineEnabled = ContextKeyExpr.and(writable, inline);
// Override workbench shortcuts only inside the editable rich text surface. Source and other workbench parts keep
// their bindings; inside a code block or on a selected node the shortcut does nothing rather than reach the workbench.
const inlineKeybinding = editorFocus;

function registerInlineAction(
  id: string,
  title: string,
  icon: string,
  key: number,
  order: number,
  toggled: ContextKeyExpression,
  run: (accessor: ServicesAccessor) => void | Promise<void>,
): void {
  registerAction2(class extends Action2 {
    constructor() {
      super({
        id, title, category: 'Markdown', f1: true, precondition: wysiwyg, toggled,
        keybinding: { primary: key, weight: formattingWeight, when: inlineKeybinding },
      });
    }

    override run(accessor: ServicesAccessor): void | Promise<void> {
      return run(accessor);
    }
  });
  MenuRegistry.appendMenuItem(toolbar, {
    group: '3_inline', order, when: wysiwyg,
    command: { id, title, icon: { id: icon }, precondition: inlineEnabled, toggled },
  });
}

for (const [order, [id, title, icon, mark, key]] of ([
  ['markdownEditor.toggleBold', 'Bold', 'bold', 'strong', KeyMod.CtrlCmd | KeyCode.KeyB],
  ['markdownEditor.toggleItalic', 'Italic', 'italic', 'em', KeyMod.CtrlCmd | KeyCode.KeyI],
  ['markdownEditor.toggleStrike', 'Strikethrough', 'strikethrough', 'strike', KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyX],
  ['markdownEditor.toggleCode', 'Inline Code', 'code', 'code', KeyMod.CtrlCmd | KeyCode.KeyE],
] as const).entries()) {
  registerInlineAction(id, title, icon, key, order, MarkdownEditorInlineMarkContexts[mark].isEqualTo(true), accessor => {
    getMarkdownPane(accessor.get(IEditorGroupsService))?.runFormattingCommand(toggleInlineFormat(mark));
  });
}

registerInlineAction(
  'markdownEditor.editLink', 'Edit Link', 'link', KeyMod.CtrlCmd | KeyCode.KeyK, 4,
  MarkdownEditorLinkContext.isEqualTo(true),
  async accessor => {
    const groups = accessor.get(IEditorGroupsService);
    const pane = getMarkdownPane(groups);
    const state = pane?.formattingState;
    if (!pane || !state || !pane.scopedContextKeyService?.contextMatchesRules(inline)) {
      return;
    }
    const value = await accessor.get(IQuickInputService).input({
      title: 'Edit Link',
      placeHolder: 'https://example.com',
      prompt: 'Leave the URL empty to remove the link.',
      value: linkAtSelection(state)?.mark.attrs.href,
      validateInput: input => normalizeMarkdownLink(input) === undefined ? 'Enter a valid link destination.' : undefined,
    });
    if (value !== undefined && getMarkdownPane(groups) === pane && pane.formattingState === state) {
      pane.runFormattingCommand(setMarkdownLink(value));
    }
  },
);


function registerInsertAction(
  id: string, title: string, menu: MenuId, order: number, command: Command, icon?: string,
): void {
  MenuRegistry.appendMenuItem(menu, {
    group: menu === toolbar ? '6_insert' : undefined, order, when: wysiwyg,
    command: { id, title, precondition: writable, ...(icon && { icon: { id: icon } }) },
  });
  registerAction2(class extends Action2 {
    constructor() {
      super({ id, title, category: 'Markdown', f1: true, precondition: ContextKeyExpr.and(wysiwyg, writable) });
    }
    override run(accessor: ServicesAccessor): void {
      const pane = getMarkdownPane(accessor.get(IEditorGroupsService));
      if (pane?.runFormattingCommand(command)) pane.focus();
    }
  });
}

registerInsertAction('markdownEditor.insertBulletList', 'Bullet List', toolbar, 0, setMarkdownList('bullet'), 'list-unordered');
registerInsertAction('markdownEditor.insertOrderedList', 'Numbered List', toolbar, 1, setMarkdownList('ordered'), 'list-ordered');
registerInsertAction('markdownEditor.insertTaskList', 'Task List', toolbar, 2, setMarkdownList('task'), 'checklist');
const tableMenu = MenuId.for('MarkdownEditorToolbar.Table');
MenuRegistry.appendMenuItem(toolbar, { submenu: tableMenu, group: '6_insert', order: 3, title: 'Table', when: wysiwyg });
registerInsertAction('markdownEditor.insertTable', 'Insert Table', tableMenu, 0, insertMarkdownTable);
for (const [order, [edit, title]] of ([
  ['addRow', 'Add Row After'], ['deleteRow', 'Delete Row'], ['addColumn', 'Add Column After'],
  ['deleteColumn', 'Delete Column'], ['alignLeft', 'Align Column Left'], ['alignCenter', 'Align Column Center'],
  ['alignRight', 'Align Column Right'], ['clearAlignment', 'Clear Column Alignment'], ['deleteTable', 'Delete Table'],
] as const).entries()) {
  registerInsertAction(`markdownEditor.table.${edit}`, title, tableMenu, order + 1, editMarkdownTable(edit));
}
registerInsertAction('markdownEditor.insertHorizontalRule', 'Horizontal Rule', toolbar, 4, (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code) return false;
  const tr = state.tr.replaceSelectionWith(markdownSchema.nodes.horizontal_rule.create());
  if (!tr.docChanged) return false;
  const end = tr.doc.resolve(tr.selection.to);
  if (!end.parent.isTextblock && end.depth === 0) {
    tr.insert(end.pos, markdownSchema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, end.pos + 1));
  }
  dispatch?.(tr.scrollIntoView());
  return true;
}, 'horizontal-rule');

const imageId = 'markdownEditor.editImage';
MenuRegistry.appendMenuItem(toolbar, {
  group: '6_insert', order: 5, when: wysiwyg,
  command: { id: imageId, title: 'Image', icon: { id: 'file-media' }, precondition: writable },
});
registerAction2(class extends Action2 {
  constructor() {
    super({ id: imageId, title: 'Insert or Edit Image', category: 'Markdown', f1: true, precondition: ContextKeyExpr.and(wysiwyg, writable) });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const groups = accessor.get(IEditorGroupsService);
    const pane = getMarkdownPane(groups);
    const state = pane?.formattingState;
    if (!pane || !state) return;
    const image = selectedMarkdownImage(state.selection);
    const quickInput = accessor.get(IQuickInputService);
    const address = await quickInput.input({
      title: 'Image Address', placeHolder: 'images/photo.png or https://example.com/photo.png', value: image?.attrs.src,
      validateInput: value => normalizeMarkdownLink(value) ? undefined : 'Enter an image URL or a relative path.',
    });
    if (!address || getMarkdownPane(groups) !== pane || pane.formattingState !== state) return;
    const alt = await quickInput.input({
      title: 'Image Description', prompt: 'Describe the image for readers who cannot see it.', value: image?.attrs.alt
        ?? state.doc.textBetween(state.selection.from, state.selection.to, ' '),
    });
    if (alt !== undefined && getMarkdownPane(groups) === pane && pane.formattingState === state
        && pane.runFormattingCommand(setMarkdownImage(address, alt))) pane.focus();
  }
});
