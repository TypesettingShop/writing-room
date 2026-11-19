// 이 영역의 기능은 배정된 에픽에서 이 파일에 등록한다.
// The real text file service replaces the untitled-only one: this file is imported after the editor part's.
import '../../../services/textfile/browser/textFileService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor } from '../../../browser/editor.js';
import type { IEditorPaneRegistry } from '../../../browser/editor.js';
import { registerWorkbenchContribution2 } from '../../../common/contributions.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { FileEditorInputSerializer, FileEditorResolverContribution } from './editors/fileEditorHandler.js';
import { FileEditorInput } from './editors/fileEditorInput.js';
import { TextFileEditor } from './editors/textFileEditor.js';
import { TextFileSaveErrorHandler } from './editors/textFileSaveErrorHandler.js';
import { FileBackupRestorer } from './fileBackupRestorer.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(TextFileEditor, TextFileEditor.ID, 'Text File Editor'),
  [FileEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(FileEditorInput.ID, FileEditorInputSerializer);

registerWorkbenchContribution2(FileEditorResolverContribution.ID, FileEditorResolverContribution);
registerWorkbenchContribution2(TextFileSaveErrorHandler.ID, TextFileSaveErrorHandler);
registerWorkbenchContribution2(FileBackupRestorer.ID, FileBackupRestorer);
