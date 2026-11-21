import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';
import { getTextModelEdit } from '../../../../editor/common/model.js';
import type { IModelContentChangedEvent, ISingleEditOperation, ITextModel } from '../../../../editor/common/model.js';

interface SourceDocument {
  readonly doc: Node;
  /** The text `doc` and `paragraphIndices` describe. */
  readonly text: string;
  readonly paragraphIndices: ReadonlyMap<number, number>;
  /** The parser's source provenance is built on demand for a document updated one block at a time. */
  readonly incrementalText?: string;
}

interface SourceSnapshot {
  readonly text: string;
  readonly provenance: SourceDocument;
}

const markdownHistory = history({ newGroupDelay: 500 });
// Exclude most Markdown delimiters and indentation before parsing a line outside its document context.
// Markdown syntax is ASCII, so prose punctuation and symbols beyond ASCII stay plain text. A line that
// still parses as another block (`1. item`, `1) item`) fails the markup check in updatePlainParagraph.
const plainParagraph = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N} .,!?;:'"()%\/@=+-]|(?![\x00-\x7f])[\p{P}\p{S}])*$/u;

function parseSource(text: string): SourceDocument {
  const { doc, blocks } = parseMarkdownWithSource(text);
  const paragraphIndices = new Map<number, number>();
  const paragraph = doc.type.schema.nodes.paragraph;
  let blockIndex = 0;
  doc.forEach((node, offset, index) => {
    const block = blocks[blockIndex];
    if (block?.from === offset) {
      blockIndex++;
      if (node.type === paragraph && block.endLine === block.startLine + 1) {
        paragraphIndices.set(block.startLine + 1, index);
      }
    }
  });
  return { doc, text, paragraphIndices };
}

/** One pane's ProseMirror state, synchronized with the shared text file. */
export class MarkdownEditorModel extends Disposable {
  state: EditorState;
  private sourceDoc: SourceDocument;
  private lastSource: string;
  // History's replacement slices hold these fragments while the external changes can be undone.
  private readonly snapshots = new WeakMap<Fragment, SourceSnapshot>();
  // Each version this model is writing, with the count of text reads when the write started.
  private readonly writingVersions = new Map<number, number>();
  private textReads = 0;
  private serializerProvenance: {
    readonly source: SourceDocument;
    readonly parsed: Node;
    readonly identities: ReadonlyMap<Node, Node>;
  } | undefined;

  constructor(
    readonly textModel: ITextModel,
    private readonly plugins: readonly Plugin[],
    private readonly onStateChange: (state: EditorState) => void,
    private readonly writeEdit: (edit: ISingleEditOperation) => void = edit => textModel.applyEdits([edit]),
  ) {
    super();
    this.lastSource = textModel.getValue();
    this.sourceDoc = parseSource(this.lastSource);
    this.state = EditorState.create({ doc: this.sourceDoc.doc, plugins: [markdownHistory, ...plugins] });
    this._register(textModel.onDidChangeContent(event => {
      // During reentrant delivery the live model may already include a later event.
      const next = event.versionId === textModel.getVersionId()
        ? textModel.getValue()
        : event.changes.reduce((text, change) => text.slice(0, change.rangeOffset) + change.text +
          text.slice(change.rangeOffset + change.rangeLength), this.lastSource);
      const reads = this.writingVersions.get(event.versionId);
      this.writingVersions.delete(event.versionId);
      // A change delivered late during the write replaced the state the write came from. Read the
      // written text too, so the state matches the model again.
      if (reads !== undefined && reads === this.textReads) {
        this.lastSource = next;
      } else {
        this.readText(event, next);
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
      const source = snapshot?.text ?? this.serializeDocument(this.state.doc);
      if (fromHistory && !snapshot) {
        // Undoing later typing rebuilds the fragment an external change produced. A redo of that
        // change starts from this fragment and has to find the text and provenance written here.
        this.snapshots.set(this.state.doc.content, { text: source, provenance: this.sourceDoc });
      }
      const edit = getTextModelEdit(this.textModel, source);
      if (edit) {
        this.writeText(edit);
      }
    }
    this.onStateChange(this.state);
  }

  private serializeDocument(doc: Node): string {
    const source = this.sourceDoc;
    if (source.incrementalText === undefined) {
      return serializeMarkdown(source.doc.copy(doc.content));
    }
    if (doc.eq(source.doc)) {
      return source.incrementalText;
    }
    // Reattach the parser's identities for blocks carried forward from the latest source edit.
    // This lets the serializer keep their spelling and gaps when a rich edit changes other blocks.
    if (this.serializerProvenance?.source !== source) {
      const parsed = parseMarkdownWithSource(source.incrementalText).doc;
      const identities = new Map<Node, Node>();
      // Only a block the full parse reads the same way can take that parse's spelling.
      if (parsed.childCount === source.doc.childCount) {
        source.doc.forEach((node, _offset, index) => {
          const block = parsed.child(index);
          if (node.eq(block)) {
            identities.set(node, block);
          }
        });
      }
      this.serializerProvenance = { source, parsed, identities };
    }
    const { parsed, identities } = this.serializerProvenance;
    const blocks: Node[] = [];
    doc.forEach(node => blocks.push(identities.get(node) ?? node));
    return serializeMarkdown(parsed.copy(Fragment.fromArray(blocks)));
  }

  private writeText(edit: ISingleEditOperation): void {
    const model = this.textModel;
    const version = model.getVersionId() + 1;
    this.writingVersions.set(version, this.textReads);
    try {
      this.writeEdit(edit);
    } finally {
      if (model.getVersionId() < version) {
        this.writingVersions.delete(version);
      }
    }
  }

  private applyTransaction(transaction: Transaction, isolate: boolean): EditorState {
    if (!isolate || !transaction.docChanged) {
      return this.state.apply(transaction);
    }
    const state = this.state.apply(closeHistory(transaction));
    return state.apply(closeHistory(state.tr));
  }

  private readText(event: IModelContentChangedEvent, next: string): void {
    const previous = this.lastSource;
    if (next === previous) {
      return;
    }
    this.textReads++;
    const { state } = this;
    const source = this.updatePlainParagraph(event, next) ?? parseSource(next);
    const doc = source.doc;
    this.snapshots.set(state.doc.content, { text: previous, provenance: this.sourceDoc });
    this.lastSource = next;
    const start = state.doc.content.findDiffStart(doc.content);
    const end = state.doc.content.findDiffEnd(doc.content);
    this.sourceDoc = source;
    this.serializerProvenance = undefined;
    // The replacement keeps exact source states in history, including spelling-only changes.
    // For a local paragraph edit both slices share every untouched block.
    const transaction = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    this.snapshots.set(transaction.doc.content, { text: next, provenance: source });
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

  private updatePlainParagraph(event: IModelContentChangedEvent, next: string): SourceDocument | undefined {
    const { doc, text: sourceText, paragraphIndices } = this.sourceDoc;
    // Patch only a tree that describes the model's previous text; anything else gets a full parse.
    if (this.state.doc.content !== doc.content || sourceText !== this.lastSource || event.isFlush ||
        event.changes.length !== 1) {
      return;
    }
    const { range, rangeOffset, rangeLength, text } = event.changes[0];
    const index = paragraphIndices.get(range.startLineNumber);
    if (index === undefined || range.startLineNumber !== range.endLineNumber || /[\r\n]/.test(text)) {
      return;
    }
    const { eol } = event;
    const previous = this.lastSource;
    const column = range.startColumn - 1;
    const start = rangeOffset - column;
    const newline = previous.indexOf(eol, start);
    const end = newline === -1 ? previous.length : newline;
    // A blank line (or the file boundary) on both sides keeps block rules local to this paragraph.
    const blank = eol + eol;
    if ((start !== 0 && !previous.startsWith(blank, start - blank.length)) ||
        (end !== previous.length && end + eol.length !== previous.length && !previous.startsWith(blank, end))) {
      return;
    }
    const before = previous.slice(start, end);
    const after = before.slice(0, column) + text + before.slice(column + rangeLength);
    if (!plainParagraph.test(before) || !plainParagraph.test(after)) {
      return;
    }
    const oldBlock = doc.child(index);
    const updated = parseMarkdownWithSource(after).doc;
    const newBlock = updated.firstChild;
    if (!newBlock || updated.childCount !== 1 || !newBlock.sameMarkup(oldBlock) ||
        oldBlock.textContent !== before.trimEnd() || newBlock.textContent !== after.trimEnd()) {
      return;
    }
    return { doc: doc.copy(doc.content.replaceChild(index, newBlock)), text: next, paragraphIndices, incrementalText: next };
  }
}
