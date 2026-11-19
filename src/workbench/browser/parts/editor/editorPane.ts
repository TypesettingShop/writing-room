import type { Dimension } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import type { IEditorPane } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { DEFAULT_EDITOR_MAX_DIMENSIONS, DEFAULT_EDITOR_MIN_DIMENSIONS } from './editor.js';

/**
 * Shows an `EditorInput`. A group keeps one pane per pane type and reuses it for every input of that
 * type, so a pane holds no state of an editor beyond the input it shows right now: the content lives
 * in the input's model and the view state travels through `setInput` and `getViewState`.
 */
export abstract class EditorPane extends Disposable implements IEditorPane {
  private _input: EditorInput | undefined;
  private _options: IEditorOptions | undefined;
  private container: HTMLElement | undefined;

  readonly minimumWidth = DEFAULT_EDITOR_MIN_DIMENSIONS.width;
  readonly maximumWidth = DEFAULT_EDITOR_MAX_DIMENSIONS.width;
  readonly minimumHeight = DEFAULT_EDITOR_MIN_DIMENSIONS.height;
  readonly maximumHeight = DEFAULT_EDITOR_MAX_DIMENSIONS.height;

  constructor(readonly id: string) {
    super();
  }

  get input(): EditorInput | undefined {
    return this._input;
  }

  get options(): IEditorOptions | undefined {
    return this._options;
  }

  /**
   * The pane's own context key scope, a child of its group's, when it has one. The group's title
   * menu is evaluated in it, so a `when` clause there sees the keys of the editor it shows.
   */
  get scopedContextKeyService(): IContextKeyService | undefined {
    return undefined;
  }

  getContainer(): HTMLElement | undefined {
    return this.container;
  }

  /** Builds the pane's DOM inside `parent`. Called once, before anything else. */
  create(parent: HTMLElement): void {
    if (this.container) {
      throw new Error(`Editor pane ${this.id} is already created.`);
    }
    this.container = parent;
    this.createEditor(parent);
  }

  protected abstract createEditor(parent: HTMLElement): void;

  /**
   * Shows `input`. The promise settles when the input is showing; when a later `setInput`,
   * `clearInput` or `dispose` replaced it first, it settles once its own load ends, showing nothing.
   * It does not reject: a pane shows its own errors.
   */
  async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    this._input = input;
    this._options = options;
  }

  /** Stops showing the current input and lets go of everything that belongs to it. */
  clearInput(): void {
    this._input = undefined;
    this._options = undefined;
  }

  /** The pane's size. Layout is explicit: a pane never measures itself. */
  abstract layout(dimension: Dimension): void;

  focus(): void {}

  /**
   * The view state of the current input, or of `input`, which the pane showed before, for `setInput`
   * of another pane to continue from. A group reads it for an editor that moves to another group.
   */
  getViewState(_input?: EditorInput): object | undefined {
    return undefined;
  }
}
