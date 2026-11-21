import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import {
  MarkdownEditorCanRedoContext, MarkdownEditorCanUndoContext, MarkdownEditorModeContext,
} from '../common/markdownEditor.js';

const toolbar = MenuId.MarkdownEditorToolbar;
const wysiwyg = MarkdownEditorModeContext.isEqualTo('wysiwyg');

for (const [order, [id, title, icon, precondition]] of ([
  ['undo', 'Undo', 'discard', MarkdownEditorCanUndoContext.isEqualTo(true)],
  ['redo', 'Redo', 'redo', MarkdownEditorCanRedoContext.isEqualTo(true)],
] as const).entries()) {
  MenuRegistry.appendMenuItem(toolbar, {
    group: '1_history', order, when: wysiwyg,
    command: { id, title, icon: { id: icon }, precondition },
  });
}
