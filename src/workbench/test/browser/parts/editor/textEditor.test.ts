import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Dimension } from '../../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { CodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import type { ITextEditorModel } from '../../../../../editor/common/services/resolverService.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { NullConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { TextEditorPane } from '../../../../browser/parts/editor/textEditor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

// jsdom cannot run Monaco, so the adapter is replaced by an editor that records what the pane asks.
const fake = vi.hoisted(() => {
  class FakeEditor {
    model: unknown = null;
    readonly setModelCalls: unknown[] = [];
    readonly restored: unknown[] = [];
    readonly layouts: { width: number; height: number }[] = [];
    readonly updates: Record<string, unknown>[] = [];
    focused = 0;
    disposed = false;
    readonly focusText = new Set<() => void>();
    readonly blurText = new Set<() => void>();
    readonly focusWidget = new Set<() => void>();
    readonly blurWidget = new Set<() => void>();
    constructor(readonly container: HTMLElement, readonly options: Record<string, unknown>) {}
    private on(set: Set<() => void>) {
      return (listener: () => void) => {
        set.add(listener);
        return { dispose: () => set.delete(listener) };
      };
    }
    onDidFocusEditorText = this.on(this.focusText);
    onDidBlurEditorText = this.on(this.blurText);
    onDidFocusEditorWidget = this.on(this.focusWidget);
    onDidBlurEditorWidget = this.on(this.blurWidget);
    readonly selectionChanged = new Set<(event: { selection: { isEmpty(): boolean } }) => void>();
    onDidChangeCursorSelection = (listener: (event: { selection: { isEmpty(): boolean } }) => void) => {
      this.selectionChanged.add(listener);
      return { dispose: () => this.selectionChanged.delete(listener) };
    };
    getSelection() { return { isEmpty: () => true }; }
    setModel(model: unknown) {
      this.setModelCalls.push(model);
      this.model = model;
    }
    getModel() { return this.model; }
    saveViewState() {
      return this.model ? { of: String((this.model as { uri: unknown }).uri), at: this.setModelCalls.length } : null;
    }
    restoreViewState(state: unknown) { this.restored.push(state); }
    layout(dimension: { width: number; height: number }) { this.layouts.push(dimension); }
    updateOptions(options: Record<string, unknown>) { this.updates.push(options); }
    focus() { this.focused++; }
    hasWidgetFocus() { return this.focused > 0; }
    dispose() { this.disposed = true; }
  }
  const state = {
    editors: [] as FakeEditor[],
    models: [] as { uri: { toString(): string }; isDisposed(): boolean }[],
    failures: 0,
  };
  const monaco = {
    editor: {
      create: (container: HTMLElement, options: Record<string, unknown>) => {
        const editor = new FakeEditor(container, options);
        state.editors.push(editor);
        return editor;
      },
      getModel: (uri: { toString(): string }) =>
        state.models.find(model => !model.isDisposed() && model.uri.toString() === uri.toString()) ?? null,
    },
    Uri: { parse: (value: string) => ({ toString: () => value }) },
  };
  return {
    state,
    FakeEditor,
    load: async () => {
      if (state.failures > 0) {
        state.failures--;
        throw new TypeError('Failed to fetch dynamically imported module');
      }
      return monaco;
    },
  };
});

vi.mock('../../../../../editor/browser/monaco.js', () => ({ loadMonaco: () => fake.load() }));

type FakeEditor = InstanceType<typeof fake.FakeEditor>;

class FakeMonacoTextModel extends TestTextModel {
  private tabSize = 4;
  getOptions(): { tabSize: number } { return { tabSize: this.tabSize }; }
  updateOptions(options: { tabSize: number }): void { this.tabSize = options.tabSize; }
}

class TestTextInput extends EditorInput {
  readonly textModel: TestTextModel;
  /** When set, `resolve` waits for it. */
  gate: Promise<void> | undefined;

  constructor(name: string) {
    super();
    this.textModel = new FakeMonacoTextModel(URI.parse(`test:${name}`), name, 'plaintext');
    fake.state.models.push(this.textModel);
  }

  override get typeId(): string { return 'test.textInput'; }
  override get resource(): URI { return this.textModel.uri; }

  override async resolve(): Promise<ITextEditorModel> {
    await this.gate;
    return { textEditorModel: this.textModel, dispose: () => {} };
  }

  override dispose(): void {
    super.dispose();
    this.textModel.dispose();
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => resolve = done);
  return { promise, resolve };
}

let contextKeys: ContextKeyService;
let codeEditors: CodeEditorService;
const panes: TextEditorPane[] = [];

class TestConfiguration implements IConfigurationService {
  declare readonly _serviceBrand: undefined;
  readonly values = new Map<string, unknown>();
  private readonly changed = new Emitter<IConfigurationChangeEvent>();
  readonly onDidChangeConfiguration = this.changed.event;
  readonly onDidChangeUserSettings = Event.None;
  getValue<T>(key?: string): T | undefined { return key === undefined ? undefined : this.values.get(key) as T | undefined; }
  async updateValue(): Promise<void> {}
  getUserSettingsText(): string { return '{}'; }
  saveUserSettings(): void {}
  change(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.values.set(key, value);
    }
    this.changed.fire({ affectsConfiguration: key => Object.keys(values).some(name => name === key || name.startsWith(key + '.')) });
  }
  dispose(): void { this.changed.dispose(); }
}

function createPane(
  size = new Dimension(300, 200), configuration: IConfigurationService = new NullConfigurationService(),
): { pane: TextEditorPane; parent: HTMLElement } {
  const parent = document.body.appendChild(document.createElement('div'));
  const pane = new TextEditorPane(contextKeys, configuration, codeEditors);
  pane.create(parent);
  if (size.width > 0) {
    pane.layout(size);
  }
  panes.push(pane);
  return { pane, parent };
}

function editorOf(pane: TextEditorPane): FakeEditor {
  return pane.getControl() as unknown as FakeEditor;
}

beforeEach(() => {
  contextKeys = new ContextKeyService();
  codeEditors = new CodeEditorService();
  fake.state.editors.length = 0;
  fake.state.models.length = 0;
  fake.state.failures = 0;
});

afterEach(() => {
  panes.splice(0).forEach(pane => pane.dispose());
  document.body.replaceChildren();
});

test('a first setInput that finishes late does not attach its model over a newer one', async () => {
  const { pane } = createPane();
  const first = new TestTextInput('first');
  const second = new TestTextInput('second');
  const gate = deferred();
  first.gate = gate.promise;

  const firstShown = pane.setInput(first, undefined);
  await pane.setInput(second, undefined);
  gate.resolve();
  await firstShown;

  const editor = editorOf(pane);
  expect(pane.input).toBe(second);
  expect(editor.getModel()).toBe(second.textModel);
  expect(editor.setModelCalls).not.toContain(first.textModel);
});

test('a clearInput during loading keeps the late model out', async () => {
  const { pane } = createPane();
  const input = new TestTextInput('late');
  const gate = deferred();
  input.gate = gate.promise;
  const shown = pane.setInput(input, undefined);
  pane.clearInput();
  gate.resolve();
  await shown;
  expect(editorOf(pane)?.getModel() ?? null).toBeNull();
  expect(pane.input).toBeUndefined();
});

test('creates the Monaco editor once, on the first real layout, without a model of its own', async () => {
  const { pane } = createPane(Dimension.None);
  const input = new TestTextInput('text');
  await pane.setInput(input, undefined);
  expect(fake.state.editors).toHaveLength(0);

  pane.layout(new Dimension(0, 100));
  expect(fake.state.editors).toHaveLength(0);

  pane.layout(new Dimension(400, 300));
  const [editor] = fake.state.editors;
  expect(fake.state.editors).toHaveLength(1);
  expect(editor.options).toMatchObject({ model: null, automaticLayout: false, dimension: { width: 400, height: 300 } });
  expect(editor.getModel()).toBe(input.textModel);

  pane.layout(new Dimension(500, 250));
  expect(fake.state.editors).toHaveLength(1);
  expect(editor.layouts.at(-1)).toEqual({ width: 500, height: 250 });
});

test('waits for a pane that is not in the document', async () => {
  const pane = new TextEditorPane(contextKeys, new NullConfigurationService(), codeEditors);
  panes.push(pane);
  const parent = document.createElement('div');
  pane.create(parent);
  pane.layout(new Dimension(300, 200));
  await pane.setInput(new TestTextInput('detached'), undefined);
  expect(fake.state.editors).toHaveLength(0);

  document.body.append(parent);
  pane.layout(new Dimension(300, 200));
  expect(fake.state.editors).toHaveLength(1);
});

test('keeps each input\'s view state when the pane switches inputs, and an explicit view state wins', async () => {
  const { pane } = createPane();
  const a = new TestTextInput('a');
  const b = new TestTextInput('b');
  await pane.setInput(a, undefined);
  const editor = editorOf(pane);
  const stateOfA = pane.getViewState();
  expect(stateOfA).toEqual({ of: 'test:a', at: 1 });

  await pane.setInput(b, undefined);
  expect(editor.getModel()).toBe(b.textModel);
  expect(editor.restored).toEqual([]);

  await pane.setInput(a, undefined);
  expect(editor.getModel()).toBe(a.textModel);
  expect(editor.restored).toEqual([stateOfA]);

  const carried = { of: 'elsewhere' };
  await pane.setInput(b, { viewState: carried });
  expect(editor.restored.at(-1)).toBe(carried);
});

test('detaches the model on clearInput and before an input it shows is disposed', async () => {
  const { pane } = createPane();
  const input = new TestTextInput('closing');
  await pane.setInput(input, undefined);
  const editor = editorOf(pane);

  pane.clearInput();
  expect(editor.getModel()).toBeNull();
  expect(input.textModel.isDisposed()).toBe(false);

  await pane.setInput(input, undefined);
  const disposedWhenDetached: boolean[] = [];
  const setModel = editor.setModel.bind(editor);
  editor.setModel = model => {
    disposedWhenDetached.push(input.textModel.isDisposed());
    setModel(model);
  };
  input.dispose();
  expect(editor.getModel()).toBeNull();
  expect(disposedWhenDetached).toEqual([false]);
  expect(pane.input).toBeUndefined();
  expect(input.textModel.isDisposed()).toBe(true);
});

test('two panes share an input\'s model and closing one leaves the model to the other', async () => {
  const left = createPane().pane;
  const right = createPane().pane;
  const input = new TestTextInput('shared');
  await left.setInput(input, undefined);
  await right.setInput(input, undefined);
  expect(editorOf(left).getModel()).toBe(input.textModel);
  expect(editorOf(right).getModel()).toBe(input.textModel);

  left.clearInput();
  left.dispose();
  expect(editorOf(left).disposed).toBe(true);
  expect(input.textModel.isDisposed()).toBe(false);
  expect(editorOf(right).getModel()).toBe(input.textModel);
});

test('shows a message instead of rejecting when the editor cannot load, and loads on the next try', async () => {
  const { pane, parent } = createPane();
  fake.state.failures = 1;
  await expect(pane.setInput(new TestTextInput('offline'), undefined)).resolves.toBeUndefined();
  const message = parent.querySelector<HTMLElement>('[role="alert"]')!;
  expect(message.hidden).toBe(false);
  expect(message.textContent).toContain('could not be opened');

  const input = new TestTextInput('online');
  await pane.setInput(input, undefined);
  expect(message.hidden).toBe(true);
  expect(editorOf(pane).getModel()).toBe(input.textModel);
});

test('focuses once the editor exists and keeps the focus keys in the pane\'s scope', async () => {
  const { pane, parent } = createPane(Dimension.None);
  const input = new TestTextInput('focus');
  pane.focus();
  await pane.setInput(input, undefined);
  pane.layout(new Dimension(300, 200));
  const editor = editorOf(pane);
  expect(editor.focused).toBe(1);

  const inside = parent.querySelector('.text-editor-container')!;
  const keys = () => ['editorTextFocus', 'editorFocus', 'textInputFocus']
    .map(key => contextKeys.getContext(inside).getValue(key));
  expect(keys()).toEqual([false, false, false]);
  editor.focusWidget.forEach(listener => listener());
  editor.focusText.forEach(listener => listener());
  expect(keys()).toEqual([true, true, true]);
  expect(contextKeys.getContextKeyValue('editorTextFocus')).toBeUndefined();
  editor.blurText.forEach(listener => listener());
  editor.blurWidget.forEach(listener => listener());
  expect(keys()).toEqual([false, false, false]);
});

test('an editor with focus keeps it across an input switch, one without does not take it', async () => {
  const { pane } = createPane();
  await pane.setInput(new TestTextInput('unfocused'), undefined);
  const editor = editorOf(pane);
  await pane.setInput(new TestTextInput('still unfocused'), undefined);
  expect(editor.focused).toBe(0);

  pane.focus();
  expect(editor.focused).toBe(1);
  await pane.setInput(new TestTextInput('focused'), undefined);
  expect(editor.focused).toBe(2);
});

test('hands on the view state it was given while the input is still loading', async () => {
  const { pane } = createPane();
  const input = new TestTextInput('loading');
  const gate = deferred();
  input.gate = gate.promise;
  const carried = { of: 'elsewhere' };
  const shown = pane.setInput(input, { viewState: carried });
  expect(pane.getViewState()).toBe(carried);

  // Showing the same input again before it loaded keeps what it was given.
  const again = pane.setInput(input, undefined);
  gate.resolve();
  await Promise.all([shown, again]);
  expect(editorOf(pane).restored).toEqual([carried]);
});

test('forgets the view state of an input it shows when that input is disposed', async () => {
  const { pane } = createPane();
  const input = new TestTextInput('closed');
  await pane.setInput(input, undefined);
  input.dispose();
  // Nothing outside the pane can see the map; the entry would keep the closed input alive.
  expect((pane as unknown as { viewStates: Map<unknown, unknown> }).viewStates.size).toBe(0);
});

test('a pane disposed right after setInput takes nothing over', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { pane } = createPane();
    const input = new TestTextInput('abandoned');
    const shown = pane.setInput(input, undefined);
    pane.dispose();
    await shown;
    expect(warn).not.toHaveBeenCalled();
    expect(fake.state.editors).toHaveLength(0);
  } finally {
    warn.mockRestore();
  }
});

test('dispose takes back what the pane put into its parent', () => {
  const { pane, parent } = createPane();
  pane.dispose();
  expect(parent.classList.contains('text-editor')).toBe(false);
  expect(parent.children).toHaveLength(0);
});

test('creates the editor with the configured options and applies changes to it and to the tab size of its model', async () => {
  const configuration = new TestConfiguration();
  configuration.values.set('editor.fontSize', 20);
  configuration.values.set('editor.tabSize', 2);
  try {
    const { pane } = createPane(undefined, configuration);
    const input = new TestTextInput('configured');
    await pane.setInput(input, undefined);
    const editor = editorOf(pane);
    const model = input.textModel as FakeMonacoTextModel;
    expect(editor.options).toMatchObject({ fontSize: 20 });
    // Monaco keeps the tab size on each model; as an editor option it would reach every model.
    expect(editor.options).not.toHaveProperty('tabSize');
    expect(model.getOptions().tabSize).toBe(2);

    configuration.change({ 'editor.fontSize': 22, 'editor.tabSize': 8 });
    expect(editor.updates.at(-1)).toMatchObject({ fontSize: 22 });
    expect(editor.updates.at(-1)).not.toHaveProperty('tabSize');
    expect(model.getOptions().tabSize).toBe(8);

    configuration.change({ 'workbench.commandPalette.history': 1 });
    expect(editor.updates).toHaveLength(1);
  } finally {
    configuration.dispose();
  }
});
