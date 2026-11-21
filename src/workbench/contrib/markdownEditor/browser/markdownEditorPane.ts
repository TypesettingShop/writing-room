import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { EditorView } from 'prosemirror-view';
import { createMarkdownIt } from '../../../../editor/common/markdown/markdownIt.js';
import { $, append } from '../../../../base/browser/dom.js';
import type { Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { describeFileOpenError } from '../../files/browser/editors/textFileEditor.js';
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
  private readonly session = this._register(new DisposableStore());
  private request = 0;
  private pendingFocus = false;

  constructor() {
    super(MarkdownEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.surface = append(parent, $('.markdown-editor-surface'));
    this.error = append(parent, $('.markdown-editor-error', { hidden: '', role: 'alert', tabindex: '-1' }));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    if (this.view && input === this.input) {
      await super.setInput(input, options);
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
      const { textEditorModel } = await input.resolve();
      if (request !== this.request) {
        return;
      }
      if (!textEditorModel || textEditorModel.isDisposed()) {
        throw new Error('the file has no text model.');
      }
      const sync = this.session.add(new MarkdownEditorModel(textEditorModel, [keymap(baseKeymap)], state => {
        this.view?.updateState(state);
      }));
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
      this.session.add(input.onDidChangeLabel(() => view.setProps({})));
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
    this.surface.hidden = false;
    this.error.hidden = true;
    this.error.textContent = '';
    super.clearInput();
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
    super.dispose();
    this.surface.remove();
    this.error.remove();
  }
}
