import '../../../../editor/browser/services/modelService.js';
import '../../../services/untitled/common/untitledTextEditorService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { UntitledTextEditorInput } from '../../../services/untitled/common/untitledTextEditorInput.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../editor.js';
import type { IEditorPaneRegistry } from '../../editor.js';
import { TextEditorPane } from './textEditor.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(TextEditorPane, TextEditorPane.ID, 'Text Editor'),
  [UntitledTextEditorInput.ID],
);
