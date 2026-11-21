import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import type { Fragment, Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';
import { getTextModelEdit } from '../../../../editor/common/model.js';
import type { ISingleEditOperation, ITextModel } from '../../../../editor/common/model.js';

interface SourceSnapshot {
  readonly text: string;
  readonly provenance: Node;
}

const markdownHistory = history({ newGroupDelay: 500 });

/** One pane's ProseMirror state, synchronized with the shared text file. */
export class MarkdownEditorModel extends Disposable {
  state: EditorState;
  private sourceDoc: Node;
  private lastSource: string;
  // A full replacement's slices hold these fragments while that external change can be undone.
  private readonly snapshots = new WeakMap<Fragment, SourceSnapshot>();
  private writingVersion: number | undefined;

  constructor(
    readonly textModel: ITextModel,
    private readonly plugins: readonly Plugin[],
    private readonly onStateChange: (state: EditorState) => void,
    private readonly writeEdit: (edit: ISingleEditOperation) => void = edit => textModel.applyEdits([edit]),
  ) {
    super();
    this.lastSource = textModel.getValue();
    this.sourceDoc = parseMarkdownWithSource(this.lastSource).doc;
    this.state = EditorState.create({ doc: this.sourceDoc, plugins: [markdownHistory, ...plugins] });
    this._register(textModel.onDidChangeContent(event => {
      if (this.writingVersion !== event.versionId) {
        this.readText();
      }
    }));
  }

  get canUndo(): boolean {
    return undoDepth(this.state) > 0;
  }

  get canRedo(): boolean {
    return redoDepth(this.state) > 0;
  }

  undo(): boolean {
    return undo(this.state, transaction => this.dispatch(transaction));
  }

  redo(): boolean {
    return redo(this.state, transaction => this.dispatch(transaction));
  }

  resetHistory(): void {
    const withoutHistory = this.state.reconfigure({ plugins: this.plugins });
    this.state = withoutHistory.reconfigure({ plugins: [markdownHistory, ...this.plugins] });
    this.onStateChange(this.state);
  }

  /** A toolbar command is one undo step, separate from the typing on either side of it. */
  runFormattingCommand(command: Command): boolean {
    return command(this.state, transaction => this.dispatch(transaction, true));
  }

  dispatch(transaction: Transaction, isolate = false): void {
    isolate ||= transaction.getMeta('uiEvent') === 'paste' || transaction.getMeta('uiEvent') === 'drop';
    const previousDoc = this.state.doc;
    this.state = this.applyTransaction(transaction, isolate);
    if (previousDoc !== this.state.doc) {
      const fromHistory = isHistoryTransaction(transaction);
      const snapshot = fromHistory ? this.snapshots.get(this.state.doc.content) : undefined;
      if (snapshot) {
        this.sourceDoc = snapshot.provenance;
      }
      const source = snapshot?.text ?? serializeMarkdown(this.sourceDoc.copy(this.state.doc.content));
      if (fromHistory && !snapshot) {
        // Undoing later typing rebuilds the fragment an external change produced. A redo of that
        // change starts from this fragment and has to find the text and provenance written here.
        this.snapshots.set(this.state.doc.content, { text: source, provenance: this.sourceDoc });
      }
      const edit = getTextModelEdit(this.textModel, source);
      if (edit) {
        const previousVersion = this.writingVersion;
        this.writingVersion = this.textModel.getVersionId() + 1;
        try {
          this.writeEdit(edit);
          this.lastSource = this.textModel.getValue();
        } finally {
          this.writingVersion = previousVersion;
        }
      }
    }
    this.onStateChange(this.state);
  }

  private applyTransaction(transaction: Transaction, isolate: boolean): EditorState {
    if (!isolate || !transaction.docChanged) {
      return this.state.apply(transaction);
    }
    const state = this.state.apply(closeHistory(transaction));
    return state.apply(closeHistory(state.tr));
  }

  private readText(): void {
    const next = this.textModel.getValue();
    if (next === this.lastSource) {
      return;
    }
    const doc = parseMarkdownWithSource(next).doc;
    const { state } = this;
    this.snapshots.set(state.doc.content, { text: this.lastSource, provenance: this.sourceDoc });
    this.lastSource = next;
    const start = state.doc.content.findDiffStart(doc.content);
    const end = state.doc.content.findDiffEnd(doc.content);
    this.sourceDoc = doc;
    // Install the parsed block identities, even if only the Markdown spelling changed.
    const transaction = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    this.snapshots.set(transaction.doc.content, { text: next, provenance: doc });
    const map = (pos: number) => {
      if (start === null || end === null || pos <= start) {
        return pos;
      }
      return pos >= end.a ? Math.max(start, pos + end.b - end.a) : Math.max(start, end.b);
    };
    const anchor = transaction.doc.resolve(map(state.selection.anchor));
    const head = transaction.doc.resolve(map(state.selection.head));
    transaction.setSelection(TextSelection.between(anchor, head));
    this.state = this.applyTransaction(transaction, true);
    this.onStateChange(this.state);
  }
}
