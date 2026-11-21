import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { EditorStateConfig, Transaction } from 'prosemirror-state';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';
import { getTextModelEdit } from '../../../../editor/common/model.js';
import type { ITextModel } from '../../../../editor/common/model.js';

/** One pane's ProseMirror state, synchronized with the shared text file. */
export class MarkdownEditorModel extends Disposable {
  state: EditorState;
  private sourceDoc: Node;
  private writingVersion: number | undefined;

  constructor(
    readonly textModel: ITextModel,
    plugins: EditorStateConfig['plugins'],
    private readonly onStateChange: (state: EditorState) => void,
  ) {
    super();
    this.sourceDoc = parseMarkdownWithSource(textModel.getValue()).doc;
    this.state = EditorState.create({ doc: this.sourceDoc, plugins });
    this._register(textModel.onDidChangeContent(event => {
      if (this.writingVersion !== event.versionId) {
        this.readText();
      }
    }));
  }

  dispatch(transaction: Transaction): void {
    const previous = this.state;
    const state = previous.apply(transaction);
    this.state = state;
    if (!previous.doc.eq(state.doc)) {
      // Keep the parser's source provenance even after a model-driven ReplaceStep.
      const edit = getTextModelEdit(this.textModel, serializeMarkdown(this.sourceDoc.copy(state.doc.content)));
      if (edit) {
        const previousVersion = this.writingVersion;
        this.writingVersion = this.textModel.getVersionId() + 1;
        try {
          this.textModel.applyEdits([edit]);
        } finally {
          this.writingVersion = previousVersion;
        }
      }
    }
    this.onStateChange(this.state);
  }

  private readText(): void {
    const doc = parseMarkdownWithSource(this.textModel.getValue()).doc;
    const { state } = this;
    const start = state.doc.content.findDiffStart(doc.content);
    const end = state.doc.content.findDiffEnd(doc.content);
    this.sourceDoc = doc;
    // Install the parsed block identities, even if only the Markdown spelling changed.
    const transaction = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    if (start === null || end === null) {
      transaction.setMeta('addToHistory', false);
    }
    const map = (pos: number) => {
      if (start === null || end === null || pos <= start) {
        return pos;
      }
      return pos >= end.a ? Math.max(start, pos + end.b - end.a) : Math.max(start, end.b);
    };
    const anchor = transaction.doc.resolve(map(state.selection.anchor));
    const head = transaction.doc.resolve(map(state.selection.head));
    transaction.setSelection(TextSelection.between(anchor, head));
    this.state = state.apply(transaction);
    this.onStateChange(this.state);
  }
}
