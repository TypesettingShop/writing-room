import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dimension } from '../../../../../base/browser/dom.js';
import { URI } from '../../../../../base/common/uri.js';
import { CodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { ITextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { TextEditorPane } from '../../../../browser/parts/editor/textEditor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { TextFileOperationError, TextFileOperationResult } from '../../../../services/textfile/common/textfiles.js';
import { TextFileEditor } from '../../browser/editors/textFileEditor.js';

// jsdom cannot run Monaco, so the adapter is replaced by an editor that keeps only its model.
const fake = vi.hoisted(() => {
  const listener = () => ({ dispose: () => {} });
  class FakeEditor {
    model: unknown = null;
    onDidFocusEditorText = listener;
    onDidBlurEditorText = listener;
    onDidFocusEditorWidget = listener;
    onDidBlurEditorWidget = listener;
    onDidChangeCursorSelection = listener;
    getSelection() { return { isEmpty: () => true }; }
    setModel(model: unknown) { this.model = model; }
    getModel() { return this.model; }
    saveViewState() { return null; }
    restoreViewState() {}
    layout() {}
    updateOptions() {}
    focus() {}
    hasWidgetFocus() { return false; }
    dispose() {}
  }
  const models: { uri: { toString(): string }; isDisposed(): boolean }[] = [];
  const monaco = {
    editor: {
      create: () => new FakeEditor(),
      getModel: (uri: { toString(): string }) =>
        models.find(model => !model.isDisposed() && model.uri.toString() === uri.toString()) ?? null,
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
  };
  return { models, load: async () => monaco };
});

vi.mock('../../../../../editor/browser/monaco.js', () => ({ loadMonaco: () => fake.load() }));

class FakeMonacoTextModel extends TestTextModel {
  getOptions(): { tabSize: number } { return { tabSize: 4 }; }
  updateOptions(): void {}
}

/** A file input whose text is its name, or which cannot be text when `failure` is set. */
class TestFileInput extends EditorInput {
  readonly textModel: TestTextModel;

  constructor(name: string, private readonly failure?: Error) {
    super();
    this.textModel = new FakeMonacoTextModel(URI.parse(`vscode-vfs://writing-room/workspace/${name}`), name, 'plaintext');
    fake.models.push(this.textModel);
  }

  override get typeId(): string { return 'test.fileInput'; }
  override get resource(): URI { return this.textModel.uri; }

  override async resolve(): Promise<ITextEditorModel> {
    if (this.failure) {
      throw this.failure;
    }
    return { textEditorModel: this.textModel, dispose: () => {} };
  }
}

const editors: TextFileEditor[] = [];

function createEditor(): TextFileEditor {
  const contextKeys = new ContextKeyService();
  const codeEditors = new CodeEditorService();
  const instantiation = {
    createInstance: () => new TextEditorPane(contextKeys, new NullConfigurationService(), codeEditors),
  } as unknown as IInstantiationService;
  const editor = new TextFileEditor(instantiation);
  editor.create(document.body.appendChild(document.createElement('div')));
  editor.layout(new Dimension(300, 200));
  editors.push(editor);
  return editor;
}

beforeEach(() => {
  fake.models.length = 0;
});

afterEach(() => {
  editors.splice(0).forEach(editor => editor.dispose());
  document.body.replaceChildren();
});

test('the file editor gives the code editor of its text pane, which shows the file', async () => {
  const editor = createEditor();
  const input = new TestFileInput('notes.md');
  await editor.setInput(input, undefined);

  const control = editor.getControl();
  expect(control).toBeDefined();
  expect(control).toBe(editor.textEditorPane.getControl());
  expect(control!.getModel()).toBe(input.textModel);
});

test('the file editor gives no code editor while the error pane stands for the file', async () => {
  const editor = createEditor();
  await editor.setInput(new TestFileInput('notes.md'), undefined);
  const binary = new TextFileOperationError('binary', TextFileOperationResult.FILE_IS_BINARY);
  await editor.setInput(new TestFileInput('data.bin', binary), undefined);

  expect(editor.getControl()).toBeUndefined();

  // A text file in the same pane gives it back.
  const next = new TestFileInput('next.md');
  await editor.setInput(next, undefined);
  expect(editor.getControl()?.getModel()).toBe(next.textModel);
});
