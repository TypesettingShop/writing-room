import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { $, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { combinedDisposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { clearMonacoUndoHistory } from '../../../../editor/browser/monaco.js';
import { createMarkdownIt } from '../../../../editor/common/markdown/markdownIt.js';
import type { ITextEditorModel } from '../../../../editor/common/services/resolverService.js';
import type { ITextEditorOptions, ITextEditorSelection } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { GroupModelChangeKind } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { TextFileEditorModel } from '../../../services/textfile/common/textFileEditorModel.js';
import { describeFileOpenError } from '../../files/browser/editors/textFileEditor.js';
import { toMarkdownSelection, toSourceSelection } from './markdownEditorSelection.js';
import { MarkdownEditorInput } from './markdownEditorInput.js';
import { MarkdownEditorModel } from './markdownEditorModel.js';
import 'prosemirror-view/style/prosemirror.css';
import './markdownEditor.css';

const { validateLink } = createMarkdownIt();

export class MarkdownEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.markdownEditor';

  private surface!: HTMLElement;
  private error!: HTMLElement;
  private view: EditorView | undefined;
  private sync: MarkdownEditorModel | undefined;
  private readonly session = this._register(new DisposableStore());
  private readonly tabModels = new Map<MarkdownEditorInput, { model: MarkdownEditorModel; lifetime: IDisposable }>();
  private readonly historyChanged = this._register(new Emitter<void>());
  readonly onDidChangeHistory = this.historyChanged.event;
  private request = 0;
  private pendingFocus = false;

  constructor(@IEditorGroupsService private readonly groups: IEditorGroupsService) {
    super(MarkdownEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.surface = append(parent, $('.markdown-editor-surface'));
    const group = this.groups.groups.find(group => group.element.contains(parent));
    if (group) {
      this._register(group.onDidModelChange(({ kind, editor }) => {
        if (kind === GroupModelChangeKind.EDITOR_CLOSE && editor instanceof MarkdownEditorInput) {
          this.forgetTabModel(editor);
        }
      }));
    }
    this.error = append(parent, $('.markdown-editor-error', { hidden: '', role: 'alert', tabindex: '-1' }));
  }

  override async setInput(input: EditorInput, options: ITextEditorOptions | undefined): Promise<void> {
    if (this.view && input === this.input) {
      void super.setInput(input, options);
      this.applySelection(options?.selection);
      return;
    }
    const focus = this.view?.hasFocus() ?? this.pendingFocus;
    this.clearInput();
    this.pendingFocus = focus && !options?.preserveFocus;
    void super.setInput(input, options);
    const request = this.request;
    if (!(input instanceof MarkdownEditorInput)) {
      return;
    }
    this.session.add(input.onWillDispose(() => this.clearInput()));

    try {
      const resolved = await input.resolve();
      if (request !== this.request) {
        return;
      }
      const sync = this.sync = this.getTabModel(input, resolved);
      const view = this.view = new EditorView(this.surface, {
        state: sync.state,
        editable: () => !input.isReadonly(),
        attributes: { role: 'textbox', 'aria-label': 'Markdown editor', 'aria-multiline': 'true' },
        transformPastedHTML: (html, view) => {
          // Apply the Markdown parser's URL policy to links and images pasted as rich text too.
          const template = view.dom.ownerDocument.createElement('template');
          template.innerHTML = html;
          for (const [selector, attribute] of [['a[href]', 'href'], ['img[src]', 'src']]) {
            for (const element of template.content.querySelectorAll(selector)) {
              if (!validateLink(element.getAttribute(attribute)!)) {
                element.removeAttribute(attribute);
              }
            }
          }
          return template.innerHTML;
        },
        nodeViews: {
          image: (node, view) => {
            const { src, alt, title } = node.attrs;
            const document = view.dom.ownerDocument;
            if (/^(?:https?:|data:)/i.test(src) && validateLink(src)) {
              const dom = document.createElement('img');
              dom.src = src;
              dom.alt = alt ?? '';
              if (title) {
                dom.title = title;
              }
              return { dom };
            }
            // Workspace-relative sources have no browser URL yet (wr-h2sa.kfw).
            const dom = document.createElement('span');
            dom.setAttribute('role', 'img');
            dom.setAttribute('aria-label', alt || 'Image');
            dom.textContent = alt || 'Image';
            return { dom };
          },
        },
        dispatchTransaction: transaction => {
          if (!transaction.docChanged || !input.isReadonly()) {
            sync.dispatch(transaction);
          }
        },
        handleDOMEvents: {
          click: (_view, event) => {
            if (event.target instanceof Element && event.target.closest('a')) {
              event.preventDefault();
              return true;
            }
            return false;
          },
        },
      });
      this.session.add(toDisposable(() => view.destroy()));
      this.session.add(input.onDidChangeLabel(() => {
        view.setProps({});
        this.historyChanged.fire();
      }));
      this.historyChanged.fire();
      this.applySelection(options?.selection);
    } catch (error) {
      if (request !== this.request) {
        return;
      }
      this.surface.hidden = true;
      this.error.hidden = false;
      this.error.textContent = `${input.getName()}: ${describeFileOpenError(error)}`;
    }
    if (this.pendingFocus) {
      this.focus();
    }
  }

  override clearInput(): void {
    this.request++;
    this.pendingFocus = false;
    this.session.clear();
    this.view = undefined;
    this.sync = undefined;
    this.surface.hidden = false;
    this.error.hidden = true;
    this.error.textContent = '';
    super.clearInput();
    this.historyChanged.fire();
  }

  private getTabModel(input: MarkdownEditorInput, resolved: ITextEditorModel): MarkdownEditorModel {
    const tab = this.tabModels.get(input);
    if (tab) {
      return tab.model;
    }
    const textModel = resolved.textEditorModel;
    if (!textModel || textModel.isDisposed()) {
      throw new Error('the file has no text model.');
    }
    const undo: Command = () => { this.undo(); return true; };
    const redo: Command = () => { this.redo(); return true; };
    const keys = keymap({ 'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo });
    const model = new MarkdownEditorModel(textModel, [keys, keymap(baseKeymap)], state => {
      if (this.input === input) {
        this.view?.updateState(state);
        this.historyChanged.fire();
      }
    }, resolved instanceof TextFileEditorModel ? edit => resolved.applyRichEditorEdit(edit) : undefined);
    const lifetime = combinedDisposable(model, input.onWillDispose(() => this.forgetTabModel(input)));
    this.tabModels.set(input, { model, lifetime });
    return model;
  }

  private forgetTabModel(input: MarkdownEditorInput): void {
    this.tabModels.get(input)?.lifetime.dispose();
    this.tabModels.delete(input);
  }

  get canUndo(): boolean {
    return this.view !== undefined && !this.input?.isReadonly() && (this.sync?.canUndo ?? false);
  }

  get canRedo(): boolean {
    return this.view !== undefined && !this.input?.isReadonly() && (this.sync?.canRedo ?? false);
  }

  undo(): boolean {
    return this.canUndo && this.sync!.undo();
  }

  redo(): boolean {
    return this.canRedo && this.sync!.redo();
  }

  runFormattingCommand(command: Command): boolean {
    return this.view !== undefined && !this.input?.isReadonly() && (this.sync?.runFormattingCommand(command) ?? false);
  }

  resetHistory(): void {
    this.sync?.resetHistory();
  }

  resetSourceHistory(): void {
    if (this.sync) {
      clearMonacoUndoHistory(this.sync.textModel);
    }
  }

  getSourceSelection(): ITextEditorSelection | undefined {
    const sync = this.sync;
    if (sync) {
      const { doc, selection } = sync.state;
      return toSourceSelection(sync.textModel, doc, selection.from, selection.to);
    }
    return undefined;
  }

  private applySelection(selection: ITextEditorSelection | undefined): void {
    const sync = this.sync;
    if (sync && selection) {
      const next = toMarkdownSelection(sync.textModel, sync.state.doc, selection);
      sync.dispatch(sync.state.tr.setSelection(next).scrollIntoView());
    }
  }

  override layout({ width, height }: Dimension): void {
    for (const element of [this.surface, this.error]) {
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
    }
  }

  override focus(): void {
    this.pendingFocus = false;
    if (this.view) {
      this.view.focus();
    } else if (!this.error.hidden) {
      this.error.focus();
    } else {
      this.pendingFocus = true;
    }
  }

  override dispose(): void {
    this.clearInput();
    for (const { lifetime } of this.tabModels.values()) {
      lifetime.dispose();
    }
    this.tabModels.clear();
    super.dispose();
    this.surface.remove();
    this.error.remove();
  }
}
