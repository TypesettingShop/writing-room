import { Emitter } from '../../../../base/common/event.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import type { EditorInput, ISaveOptions } from '../../../common/editor/editorInput.js';
import { FileEditorInputSerializer } from '../../files/browser/editors/fileEditorHandler.js';
import { FileEditorInput } from '../../files/browser/editors/fileEditorInput.js';
import { MARKDOWN_EDITOR_INPUT_ID } from '../common/markdownEditor.js';

/** The WYSIWYG tab holds the same counted text-file reference as a source tab. */
export class MarkdownEditorInput extends FileEditorInput {
  static override readonly ID = MARKDOWN_EDITOR_INPUT_ID;
  private readonly willSave = this._register(new Emitter<void>());
  readonly onWillSave = this.willSave.event;

  override save(group: GroupIdentifier, options?: ISaveOptions): Promise<EditorInput | undefined> {
    if (options?.reason !== 'auto') this.willSave.fire();
    return super.save(group, options);
  }

  override get typeId(): string {
    return MarkdownEditorInput.ID;
  }
}

export class MarkdownEditorInputSerializer extends FileEditorInputSerializer {
  protected override readonly inputType = MarkdownEditorInput;
}
