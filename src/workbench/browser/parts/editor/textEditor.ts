import { $, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { Event } from '../../../../base/common/event.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import type {
  ICodeEditorViewState, IMonacoTextModel, IStandaloneCodeEditor, IStandaloneEditorConstructionOptions, MonacoNamespace,
} from '../../../../editor/browser/monaco.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { isTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { IConfigurationPropertySchema } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { EditorPane } from './editorPane.js';
import './media/textEditor.css';

const editorSettings = {
  'editor.fontSize': { type: 'number', default: 14, minimum: 6, maximum: 100, description: 'Controls the font size in pixels.' },
  'editor.tabSize': { type: 'integer', default: 4, minimum: 1, description: 'Controls how many columns a tab occupies.' },
  'editor.wordWrap': {
    type: 'string', default: 'off', enum: ['off', 'on', 'wordWrapColumn', 'bounded'],
    description: 'Controls where editor lines wrap.',
  },
  'editor.lineNumbers': {
    type: 'string', default: 'on', enum: ['off', 'on', 'relative', 'interval'],
    description: 'Controls how editor line numbers are shown.',
  },
  'editor.minimap.enabled': { type: 'boolean', default: true, description: 'Shows the editor minimap.' },
} as const satisfies Record<string, IConfigurationPropertySchema>;

configurationRegistry.registerConfiguration({ id: 'editor', title: 'Editor', properties: editorSettings });

/**
 * Every option the text editor is created with. One function, so configuration can feed it later.
 * The pane lays the editor out itself (`automaticLayout: false`), as all layout here is explicit.
 * The theme is not among them: Monaco's theme is global, and `loadMonaco()` sets it once.
 */
export function getTextEditorOptions(configuration?: IConfigurationService): IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: false,
    ariaLabel: 'Editor content',
    fontSize: configuration?.getValue<number>('editor.fontSize') ?? editorSettings['editor.fontSize'].default,
    tabSize: configuration?.getValue<number>('editor.tabSize') ?? editorSettings['editor.tabSize'].default,
    wordWrap: configuration?.getValue<NonNullable<IStandaloneEditorConstructionOptions['wordWrap']>>('editor.wordWrap')
      ?? editorSettings['editor.wordWrap'].default,
    lineNumbers: configuration?.getValue<NonNullable<IStandaloneEditorConstructionOptions['lineNumbers']>>('editor.lineNumbers')
      ?? editorSettings['editor.lineNumbers'].default,
    minimap: {
      enabled: configuration?.getValue<boolean>('editor.minimap.enabled') ?? editorSettings['editor.minimap.enabled'].default,
    },
  };
}

interface IShownModel {
  readonly input: EditorInput;
  readonly model: IMonacoTextModel;
  /** View state to restore once the model is attached. */
  viewState: object | undefined;
}

/**
 * The text editor pane, `workbench.editors.textResourceEditor`: one Monaco editor that shows every
 * text input the pane receives. The text belongs to the input's model, which the pane only attaches;
 * the cursor and scroll belong to the input's view state, which the pane saves when it lets go.
 */
export class TextEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.textResourceEditor';

  private editorContainer!: HTMLElement;
  private messageElement!: HTMLElement;
  private monaco: MonacoNamespace | undefined;
  private editor: IStandaloneCodeEditor | undefined;
  private dimension: Dimension | undefined;
  private shown: IShownModel | undefined;
  private pendingFocus = false;
  /** Increases with every `setInput` and `clearInput`; a load that finishes under an older one is dropped. */
  private request = 0;
  private readonly inputListener = this._register(new MutableDisposable());
  private readonly viewStates = new Map<EditorInput, { state: object; listener: IDisposable }>();
  private editorTextFocus!: IContextKey<boolean>;
  private editorFocus!: IContextKey<boolean>;
  private textInputFocus!: IContextKey<boolean>;

  constructor(
    @IContextKeyService private readonly contextKeyService: IContextKeyService,
    @IConfigurationService private readonly configuration: IConfigurationService,
  ) {
    super(TextEditorPane.ID);
    this._register(configuration.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('editor') && this.editor) {
        const { tabSize, ...options } = getTextEditorOptions(configuration);
        this.editor.updateOptions(options);
        this.updateTabSize(tabSize);
      }
    }));
  }

  protected createEditor(parent: HTMLElement): void {
    parent.classList.add('text-editor');
    this.editorContainer = append(parent, $('.text-editor-container'));
    this.messageElement = append(parent, $('.text-editor-message', { role: 'alert', hidden: '' }));
    // The keys live in the pane's own scope, so they hold for what has focus inside it.
    const scoped = this._register(this.contextKeyService.createScoped(parent));
    this.editorTextFocus = EditorContextKeys.editorTextFocus.bindTo(scoped);
    this.editorFocus = EditorContextKeys.focus.bindTo(scoped);
    this.textInputFocus = EditorContextKeys.textInputFocus.bindTo(scoped);
  }

  override async setInput(input: EditorInput, options: ITextEditorOptions | undefined): Promise<void> {
    const previous = this.input;
    // The base only records the input. It is not awaited: that would leave a gap in which a newer
    // `setInput`, a `clearInput` or `dispose` runs before this call has taken the input over.
    if (previous === input && this.shown?.input === input && this.isAttached()) {
      void super.setInput(input, options);
      if (options?.viewState) {
        this.editor!.restoreViewState(options.viewState as ICodeEditorViewState);
      }
      return;
    }

    // Also when `previous` is `input` itself, still loading: its view state carries over to this load.
    if (previous) {
      this.saveViewState(previous);
    }
    const request = ++this.request;
    // Detaching takes the focus out of the editor; the next model gets it back.
    if (this.editor?.hasWidgetFocus()) {
      this.pendingFocus = true;
    }
    this.detach();
    void super.setInput(input, options);
    this.inputListener.value = input.onWillDispose(() => {
      if (this.input === input) {
        this.clearInput();
      }
    });

    let monaco: MonacoNamespace;
    let resolved: unknown;
    try {
      [monaco, resolved] = await Promise.all([loadMonaco(), input.resolve()]);
    } catch {
      if (request === this.request) {
        this.showMessage('The editor could not be opened because the text editor failed to load.');
      }
      return;
    }
    if (request !== this.request) {
      return;
    }

    const textModel = isTextEditorModel(resolved) ? resolved.textEditorModel : null;
    const model = textModel && !textModel.isDisposed()
      ? monaco.editor.getModel(monaco.Uri.parse(textModel.uri.toString()))
      : null;
    if (!model) {
      this.showMessage('The editor could not be opened because its text is not available.');
      return;
    }
    this.monaco = monaco;
    this.shown = { input, model, viewState: options?.viewState ?? this.viewStates.get(input)?.state };
    this.ensureEditor();
    this.attach();
  }

  override clearInput(): void {
    if (this.input) {
      this.saveViewState(this.input);
    }
    this.request++;
    this.inputListener.clear();
    this.pendingFocus = false;
    this.detach();
    super.clearInput();
  }

  override layout(dimension: Dimension): void {
    this.dimension = dimension;
    this.editorContainer.style.width = `${dimension.width}px`;
    this.editorContainer.style.height = `${dimension.height}px`;
    if (this.editor) {
      this.editor.layout({ width: dimension.width, height: dimension.height });
    } else {
      this.ensureEditor();
      this.attach();
    }
  }

  override focus(): void {
    if (this.isAttached()) {
      this.editor!.focus();
    } else {
      this.pendingFocus = true;
    }
  }

  override getViewState(input: EditorInput | undefined = this.input): object | undefined {
    return input && (this.currentViewState(input) ?? this.viewStates.get(input)?.state);
  }

  /** The Monaco editor, once the pane has had a real size and the package has loaded. */
  getControl(): IStandaloneCodeEditor | undefined {
    return this.editor;
  }

  private isAttached(): boolean {
    return !!this.editor && !!this.shown && this.editor.getModel() === this.shown.model;
  }

  /**
   * Monaco draws nothing useful into a container that has no size or is not in the document, so the
   * editor waits for the first real layout.
   */
  private ensureEditor(): void {
    if (this.editor || !this.monaco || !this.dimension || this.dimension.width <= 0 || this.dimension.height <= 0
      || !this.editorContainer.isConnected) {
      return;
    }
    const { width, height } = this.dimension;
    // Without `model: null` Monaco creates an empty model of its own that nothing would dispose.
    const { tabSize: _tabSize, ...options } = getTextEditorOptions(this.configuration);
    this.editor = this.monaco.editor.create(this.editorContainer, {
      ...options,
      model: null,
      dimension: { width, height },
    });
    this._register(this.editor);
    this._register(this.editor.onDidFocusEditorText(() => {
      this.editorTextFocus.set(true);
      this.textInputFocus.set(true);
    }));
    this._register(this.editor.onDidBlurEditorText(() => {
      this.editorTextFocus.set(false);
      this.textInputFocus.set(false);
    }));
    this._register(this.editor.onDidFocusEditorWidget(() => this.editorFocus.set(true)));
    this._register(this.editor.onDidBlurEditorWidget(() => this.editorFocus.set(false)));
  }

  private attach(): void {
    const shown = this.shown;
    if (!this.editor || !shown || shown.model.isDisposed()) {
      return;
    }
    this.hideMessage();
    if (this.editor.getModel() !== shown.model) {
      this.updateTabSize(getTextEditorOptions(this.configuration).tabSize);
      this.editor.setModel(shown.model);
    }
    if (shown.viewState) {
      this.editor.restoreViewState(shown.viewState as ICodeEditorViewState);
      shown.viewState = undefined;
    }
    if (this.pendingFocus) {
      this.pendingFocus = false;
      this.editor.focus();
    }
  }

  private updateTabSize(tabSize: number | undefined): void {
    const model = this.shown?.model;
    if (tabSize !== undefined && model && !model.isDisposed() && model.getOptions().tabSize !== tabSize) {
      model.updateOptions({ tabSize });
    }
  }

  private detach(): void {
    this.shown = undefined;
    this.hideMessage();
    this.editor?.setModel(null);
  }

  /** The view state `input` has in this pane right now: shown, waiting for the editor, or loading. */
  private currentViewState(input: EditorInput): object | undefined {
    if (this.shown?.input === input) {
      return this.isAttached() ? this.editor!.saveViewState() ?? undefined : this.shown.viewState;
    }
    if (this.input === input) {
      // Still loading: what the caller handed over wins, as it will when the load finishes.
      return (this.options as ITextEditorOptions | undefined)?.viewState ?? this.viewStates.get(input)?.state;
    }
    return undefined;
  }

  private saveViewState(input: EditorInput): void {
    // An input that is going away (its `onWillDispose` clears the pane) has nothing to come back to.
    if (input.isDisposed()) {
      this.viewStates.get(input)?.listener.dispose();
      this.viewStates.delete(input);
      return;
    }
    const state = this.currentViewState(input);
    if (!state) {
      return;
    }
    const entry = this.viewStates.get(input);
    if (entry) {
      entry.state = state;
    } else {
      const listener = Event.once(input.onWillDispose)(() => this.viewStates.delete(input));
      this.viewStates.set(input, { state, listener });
    }
  }

  private showMessage(message: string): void {
    this.messageElement.textContent = message;
    this.messageElement.hidden = false;
  }

  private hideMessage(): void {
    this.messageElement.hidden = true;
    this.messageElement.textContent = '';
  }

  override dispose(): void {
    this.request++;
    for (const { listener } of this.viewStates.values()) {
      listener.dispose();
    }
    this.viewStates.clear();
    this.shown = undefined;
    super.dispose();
    // The parent belongs to whoever created the pane: take back what `createEditor` put into it.
    this.editorContainer?.remove();
    this.messageElement?.remove();
    this.getContainer()?.classList.remove('text-editor');
  }
}
