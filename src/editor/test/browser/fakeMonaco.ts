import { Emitter } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { TestTextModel } from '../common/testTextModel.js';

/** A Monaco text model as far as the workbench uses one: the test model plus tab size options. */
export class FakeMonacoModel extends TestTextModel {
  private tabSize = 4;
  getOptions(): { tabSize: number } { return { tabSize: this.tabSize }; }
  updateOptions(options: { tabSize: number }): void { this.tabSize = options.tabSize; }
}

/** A Monaco code editor as far as the text editor pane uses one. jsdom cannot run the real one. */
export class FakeCodeEditor {
  private model: FakeMonacoModel | null = null;
  private textFocus = false;
  disposed = false;
  private readonly modelChanged = new Emitter<{ oldModelUrl: unknown; newModelUrl: unknown }>();
  private readonly focusText = new Emitter<void>();
  private readonly blurText = new Emitter<void>();
  private readonly focusWidget = new Emitter<void>();
  private readonly blurWidget = new Emitter<void>();
  readonly onDidChangeModel = this.modelChanged.event;
  readonly onDidFocusEditorText = this.focusText.event;
  readonly onDidBlurEditorText = this.blurText.event;
  readonly onDidFocusEditorWidget = this.focusWidget.event;
  readonly onDidBlurEditorWidget = this.blurWidget.event;
  private selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
  private readonly selectionChanged = new Emitter<{ selection: { isEmpty(): boolean } }>();
  readonly onDidChangeCursorSelection = this.selectionChanged.event;

  constructor(readonly container: HTMLElement, readonly options: Record<string, unknown>) {}

  getModel(): FakeMonacoModel | null { return this.model; }

  setModel(model: FakeMonacoModel | null): void {
    const old = this.model;
    if (old !== model) {
      this.model = model;
      // Monaco puts the cursor at the start of a model it attaches.
      this.selection = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
      this.modelChanged.fire({ oldModelUrl: old?.uri ?? null, newModelUrl: model?.uri ?? null });
    }
  }

  /** Moves the keyboard focus into the editor's text, or out of it. */
  setTextFocus(focused: boolean): void {
    if (this.textFocus !== focused) {
      this.textFocus = focused;
      (focused ? this.focusText : this.blurText).fire();
      (focused ? this.focusWidget : this.blurWidget).fire();
    }
  }

  hasTextFocus(): boolean { return this.textFocus; }
  hasWidgetFocus(): boolean { return this.textFocus; }
  focus(): void { this.setTextFocus(true); }
  saveViewState(): object | null { return this.model ? { of: this.model.uri.toString() } : null; }
  restoreViewState(): void {}
  readonly selections: unknown[] = [];
  setSelection(selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }): void {
    this.selections.push(selection);
    this.selection = selection;
    this.selectionChanged.fire({ selection: this.getSelection() });
  }

  getSelection(): { isEmpty(): boolean } {
    const { startLineNumber, startColumn, endLineNumber, endColumn } = this.selection;
    return { isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn };
  }
  revealRangeInCenter(): void {}
  layout(): void {}
  updateOptions(): void {}
  dispose(): void { this.disposed = true; }
}

/** What `loadMonaco()` resolves to in a test: the parts of Monaco's API the workbench calls. */
export class FakeMonaco {
  readonly models: FakeMonacoModel[] = [];
  readonly editors: FakeCodeEditor[] = [];

  readonly Uri = { parse: (value: string) => URI.parse(value) };

  readonly editor = {
    create: (container: HTMLElement, options: Record<string, unknown>): FakeCodeEditor => {
      const editor = new FakeCodeEditor(container, options);
      this.editors.push(editor);
      return editor;
    },
    createModel: (value: string, languageId: string, uri: URI): FakeMonacoModel => {
      if (this.editor.getModel(uri)) {
        throw new Error(`Cannot add model because it already exists: ${uri}`);
      }
      const model = new FakeMonacoModel(uri, value, languageId);
      this.models.push(model);
      return model;
    },
    getModel: (uri: { toString(): string }): FakeMonacoModel | null =>
      this.models.find(model => !model.isDisposed() && model.uri.toString() === uri.toString()) ?? null,
    getModels: (): FakeMonacoModel[] => this.models.filter(model => !model.isDisposed()),
    setModelLanguage: (model: FakeMonacoModel, languageId: string): void => model.setLanguage(languageId),
  };

  readonly json: { jsonDefaults: { readonly diagnosticsOptions: object; setDiagnosticsOptions(options: object): void } };

  constructor() {
    let options: object = {};
    this.json = {
      jsonDefaults: {
        get diagnosticsOptions() { return options; },
        setDiagnosticsOptions: (next: object) => { options = next; },
      },
    };
  }

  /** Every editor that is not disposed. */
  liveEditors(): FakeCodeEditor[] {
    return this.editors.filter(editor => !editor.disposed);
  }
}

/** Disposes every model the fake made and forgets its editors, between tests. */
export function resetFakeMonaco(monaco: FakeMonaco): IDisposable {
  return {
    dispose: () => {
      for (const model of monaco.models.splice(0)) {
        model.dispose();
      }
      monaco.editors.length = 0;
    },
  };
}
