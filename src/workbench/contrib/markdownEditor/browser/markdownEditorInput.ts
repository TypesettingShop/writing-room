import { FileEditorInputSerializer } from '../../files/browser/editors/fileEditorHandler.js';
import { FileEditorInput } from '../../files/browser/editors/fileEditorInput.js';
import { MARKDOWN_EDITOR_INPUT_ID } from '../common/markdownEditor.js';

/** The WYSIWYG tab holds the same counted text-file reference as a source tab. */
export class MarkdownEditorInput extends FileEditorInput {
  static override readonly ID = MARKDOWN_EDITOR_INPUT_ID;

  override get typeId(): string {
    return MarkdownEditorInput.ID;
  }
}

export class MarkdownEditorInputSerializer extends FileEditorInputSerializer {
  protected override readonly inputType = MarkdownEditorInput;
}
