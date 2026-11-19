import { Emitter } from '../../../base/common/event.js';
import type { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';
import type { IStandaloneCodeEditor } from '../monaco.js';

/** A Monaco code editor, as the workbench creates them. */
export type ICodeEditor = IStandaloneCodeEditor;

export const ICodeEditorService = createDecorator<ICodeEditorService>('codeEditorService');

/**
 * The code editors on the page. Each one is added when it is created and removed when it is
 * disposed; a pane that shows another model keeps its editor, and the editor's own
 * `onDidChangeModel` tells which model it shows.
 */
export interface ICodeEditorService extends BrandedService {
  readonly onCodeEditorAdd: Event<ICodeEditor>;
  readonly onCodeEditorRemove: Event<ICodeEditor>;

  addCodeEditor(editor: ICodeEditor): void;
  removeCodeEditor(editor: ICodeEditor): void;
  /** In the order they were added. */
  listCodeEditors(): readonly ICodeEditor[];
  /** The editor whose text has keyboard focus, if any. */
  getFocusedCodeEditor(): ICodeEditor | null;
}

export class CodeEditorService extends Disposable implements ICodeEditorService {
  declare readonly _serviceBrand: undefined;

  private readonly _onCodeEditorAdd = this._register(new Emitter<ICodeEditor>());
  readonly onCodeEditorAdd = this._onCodeEditorAdd.event;
  private readonly _onCodeEditorRemove = this._register(new Emitter<ICodeEditor>());
  readonly onCodeEditorRemove = this._onCodeEditorRemove.event;

  private readonly editors = new Set<ICodeEditor>();

  addCodeEditor(editor: ICodeEditor): void {
    if (!this.editors.has(editor)) {
      this.editors.add(editor);
      this._onCodeEditorAdd.fire(editor);
    }
  }

  removeCodeEditor(editor: ICodeEditor): void {
    if (this.editors.delete(editor)) {
      this._onCodeEditorRemove.fire(editor);
    }
  }

  listCodeEditors(): readonly ICodeEditor[] {
    return [...this.editors];
  }

  getFocusedCodeEditor(): ICodeEditor | null {
    for (const editor of this.editors) {
      if (editor.hasTextFocus()) {
        return editor;
      }
    }
    return null;
  }
}

registerSingleton(ICodeEditorService, CodeEditorService);
