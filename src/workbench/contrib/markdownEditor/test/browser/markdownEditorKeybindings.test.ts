import { expect, test } from 'vitest';
import { formatKeybinding } from '../../../../../base/common/keybindingLabels.js';
import { parseKeybinding } from '../../../../../base/common/keybindingParser.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingResolver, ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import '../../../../browser/actions/layoutActions.js';
import '../../../../browser/parts/editor/editorCommands.js';
import '../../browser/markdownEditorToolbar.contribution.js';
import {
  MarkdownEditorFocusContext, MarkdownEditorInlineFormattingContext, MarkdownEditorModeContext,
  MarkdownEditorWritableContext,
} from '../../common/markdownEditor.js';

test.each([
  { platform: 'linux', modifier: 'ctrl', bold: 'Ctrl+B', aria: 'Control+B' },
  { platform: 'mac', modifier: 'cmd', bold: '⌘B', aria: 'Command+B' },
] as const)('resolves Markdown shortcuts and labels on $platform without taking them outside the editor', spec => {
  const root = new ContextKeyService();
  const editor = root.createScoped();
  const { platform, modifier } = spec;
  try {
    MarkdownEditorModeContext.bindTo(root).set('wysiwyg');
    MarkdownEditorFocusContext.bindTo(editor).set(true);
    MarkdownEditorWritableContext.bindTo(editor).set(true);
    MarkdownEditorInlineFormattingContext.bindTo(editor).set(true);
    const resolver = new KeybindingResolver(KeybindingsRegistry.getDefaultKeybindings(), platform);
    const resolve = (key: string, scope = editor) => resolver.resolve(scope.getContext(null), parseKeybinding(key)!.chords[0]);
    const bold = resolver.lookupKeybinding('markdownEditor.toggleBold')!;
    expect(formatKeybinding(bold, platform)).toBe(spec.bold);
    expect(formatKeybinding(bold, platform, true)).toBe(spec.aria);
    expect(resolve(`${modifier}+b`)).toMatchObject({ kind: ResultKind.KbFound, rule: { id: 'markdownEditor.toggleBold' } });
    expect(resolve(`${modifier}+b`, root)).toMatchObject({
      kind: ResultKind.KbFound, rule: { id: 'workbench.action.toggleSidebarVisibility' },
    });
    expect(resolve(`${modifier}+k`)).toMatchObject({ kind: ResultKind.KbFound, rule: { id: 'markdownEditor.editLink' } });
    expect(resolve(`${modifier}+k`, root).kind).toBe(ResultKind.MoreChordsNeeded);
    expect(resolve(`${modifier}+alt+6`)).toMatchObject({
      kind: ResultKind.KbFound, rule: { id: 'markdownEditor.setBlockType', args: { type: 'heading', level: 6 } },
    });
    if (platform === 'mac') {
      expect(resolve('ctrl+b').kind).toBe(ResultKind.NoMatchingKb);
    }
  } finally {
    editor.dispose();
    root.dispose();
  }
});
