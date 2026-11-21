import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import { Mapping, StepMap } from 'prosemirror-transform';
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

interface SourceWrite {
  readonly source: string;
  readonly edit: ISingleEditOperation;
}

interface DeferredEdit {
  readonly owner: MarkdownEditorModel;
  readonly mapping?: Mapping;
  run(): void;
}

interface DeferredEdits {
  pending: DeferredEdit[];
  draining: boolean;
}

// Panes share the request order, even when their source listeners run in a different order.
const deferredByModel = new WeakMap<ITextModel, DeferredEdits>();

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

function appendChangedRange(ranges: number[], start: number, end: { a: number; b: number }): void {
  // Equal prefixes and suffixes can overlap for repeated text.
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  ranges.push(start, end.a + overlap - start, end.b + overlap - start);
}

function sourceChangeMap(before: Node, after: Node, start: number, end: { a: number; b: number }, changes: number): StepMap {
  const ranges: number[] = [];
  // When a batch preserves the top-level structure, keep the unchanged positions between its edits.
  // Otherwise the common prefix and suffix are the positions we can confidently map.
  if (changes > 1 && before.childCount === after.childCount) {
    let aligned = true;
    let changed = 0;
    before.forEach((block, offset, index) => {
      const updated = after.child(index);
      if (!block.sameMarkup(updated)) {
        aligned = false;
        return;
      }
      const from = block.content.findDiffStart(updated.content, offset + 1);
      const to = block.content.findDiffEnd(updated.content, offset + 1 + block.content.size, offset + 1 + updated.content.size);
      if (from !== null && to !== null) {
        changed++;
        appendChangedRange(ranges, from, to);
      }
    });
    // More changed blocks than edits means the blocks moved (one removed, another added), so the
    // same index no longer holds the same block.
    if (aligned && changed <= changes) {
      return new StepMap(ranges);
    }
    ranges.length = 0;
  }
  appendChangedRange(ranges, start, end);
  return new StepMap(ranges);
}

/** One pane's ProseMirror state, synchronized with the shared text file. */
export class MarkdownEditorModel extends Disposable {
  state: EditorState;
  private sourceDoc: SourceDocument;
  private lastSource: string;
  private version: number;
  // History's replacement slices hold these fragments while the external changes can be undone.
  private readonly snapshots = new WeakMap<Fragment, SourceSnapshot>();
  private readonly writingVersions = new Map<number, SourceWrite>();
  private readonly deferred: DeferredEdits;
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
    this.deferred = deferredByModel.get(textModel) ?? { pending: [], draining: false };
    deferredByModel.set(textModel, this.deferred);
    this.version = textModel.getVersionId();
    this.lastSource = textModel.getValue();
    this.sourceDoc = parseSource(this.lastSource);
    this.state = EditorState.create({ doc: this.sourceDoc.doc, plugins: [markdownHistory, ...plugins] });
    this._register(textModel.onDidChangeContent(event => {
      // A pane opened during another listener's delivery already starts at the live version. A
      // write's own event can also arrive after a later change that was already read with it.
      if (event.versionId <= this.version) {
        this.writingVersions.delete(event.versionId);
        return;
      }
      // A listener that changes the model while an earlier change is still being delivered makes a
      // later version arrive first. Its changes then do not start from lastSource, so read the live
      // text up to the latest version instead, and let the skipped events go by.
      const live = textModel.getVersionId();
      const skipped = event.versionId !== this.version + 1;
      const upTo = skipped ? live : event.versionId;
      // A later change can arrive before the event of this model's own write. The rich state then
      // shows the written text, and that change started from it.
      let earlier: SourceWrite | undefined;
      for (const [version, write] of this.writingVersions) {
        if (version < upTo) {
          earlier = write;
          this.writingVersions.delete(version);
        }
      }
      const earlierText = earlier?.source.replace(/\r\n|\r|\n/g, event.eol);
      // During reentrant delivery the live model may already include a later event.
      const next = upTo === live
        ? textModel.getValue()
        : event.changes.reduce((text, change) => text.slice(0, change.rangeOffset) + change.text +
          text.slice(change.rangeOffset + change.rangeLength), earlierText ?? this.lastSource);
      this.version = upTo;
      const written = this.writingVersions.get(upTo);
      this.writingVersions.delete(upTo);
      try {
        if (!skipped && written && this.matchesWrite(event, written.edit)) {
          this.lastSource = next;
        } else {
          const expected = written ? written.source.replace(/\r\n|\r|\n/g, event.eol) : earlierText;
          if (expected === next) {
            this.lastSource = next;
          } else {
            this.readText(skipped ? undefined : event, next, expected);
          }
        }
      } finally {
        // A failed read must not leave the queued rich edits of every pane waiting.
        this.drainDeferredEdits();
      }
    }));
  }

  override dispose(): void {
    this.deferred.pending = this.deferred.pending.filter(edit => edit.owner !== this);
    super.dispose();
    // Another pane's edits queued behind this model's can be ready now.
    if (!this.textModel.isDisposed()) {
      this.drainDeferredEdits();
    }
  }

  get canUndo(): boolean {
    return undoDepth(this.state) > 0;
  }

  get canRedo(): boolean {
    return redoDepth(this.state) > 0;
  }

  undo(): boolean {
    return this.runCommand(undo);
  }

  redo(): boolean {
    return this.runCommand(redo);
  }

  resetHistory(): void {
    const withoutHistory = this.state.reconfigure({ plugins: this.plugins });
    this.state = withoutHistory.reconfigure({ plugins: [markdownHistory, ...this.plugins] });
    this.onStateChange(this.state);
  }

  /** A toolbar command is one undo step, separate from the typing on either side of it. */
  runFormattingCommand(command: Command): boolean {
    return this.runCommand(command, true);
  }

  dispatch(transaction: Transaction, isolate = false): void {
    if (!this.shouldDeferEdit()) {
      this.applyDispatch(transaction, isolate);
      return;
    }
    if (isHistoryTransaction(transaction)) {
      // ProseMirror's native beforeinput history handler dispatches a history transaction as well.
      // Its history state was computed before the pending change, so rerun the command.
      this.runCommand(transaction.getMeta(markdownHistory).redo ? redo : undo);
      return;
    }
    const before = this.state;
    const mapping = new Mapping();
    this.deferred.pending.push({ owner: this, mapping, run: () => {
      const rebased = before === this.state ? transaction : this.rebaseTransaction(transaction, mapping);
      if (rebased) {
        this.applyDispatch(rebased, isolate);
      }
    } });
  }

  private shouldDeferEdit(): boolean {
    // A disposed model has no version to wait for, and a selection change still applies.
    return this.deferred.draining || this.deferred.pending.length > 0
      || (!this.textModel.isDisposed() && this.version !== this.textModel.getVersionId());
  }

  private runCommand(command: Command, isolate = false): boolean {
    const run = () => command(this.state, transaction => this.applyDispatch(transaction, isolate));
    if (!this.shouldDeferEdit()) {
      return run();
    }
    this.deferred.pending.push({ owner: this, run });
    return true;
  }

  private drainDeferredEdits(): void {
    const deferred = this.deferred;
    if (deferred.draining || deferred.pending.length === 0) {
      return;
    }
    // The model can already contain more changes than this listener has received. Record each
    // external version before applying any rich edit, even when a write reenters delivery.
    deferred.draining = true;
    try {
      while (deferred.pending[0]?.owner.version === this.textModel.getVersionId()) {
        // The caller that queued the edit has returned, so report a failure and go on with the rest.
        try {
          deferred.pending.shift()!.run();
        } catch (error) {
          console.error(error);
        }
      }
    } finally {
      deferred.draining = false;
    }
  }

  private rebaseTransaction(transaction: Transaction, over: Mapping): Transaction | undefined {
    const rebased = this.state.tr.setTime(transaction.time);
    // Each step starts in the document left by the previous step. Pair the inverse of each
    // original step with its replay so positions inside inserted content survive the mapping.
    const remap = transaction.mapping.invert();
    remap.appendMapping(over);
    for (let index = 0; index < transaction.steps.length; index++) {
      const step = transaction.steps[index].map(remap.slice(transaction.steps.length - index));
      if (!step || rebased.maybeStep(step).failed) {
        return;
      }
      remap.appendMap(step.getMap(), transaction.steps.length - 1 - index);
    }
    if (transaction.selectionSet) {
      rebased.setSelection(transaction.selection.map(rebased.doc, remap.slice()));
    }
    if (transaction.storedMarksSet) {
      rebased.setStoredMarks(transaction.storedMarks);
    }
    if (transaction.scrolledIntoView) {
      rebased.scrollIntoView();
    }
    for (const key of ['addToHistory', 'uiEvent', 'paste', 'pointer', 'composition']) {
      const value = transaction.getMeta(key);
      if (value !== undefined) {
        rebased.setMeta(key, value);
      }
    }
    for (const plugin of this.plugins) {
      const value = transaction.getMeta(plugin);
      if (value === undefined) {
        continue;
      }
      if (plugin.spec.isInputRules) {
        const from = over.map(value.from, 1);
        const to = Math.max(from, over.map(value.to, -1));
        rebased.setMeta(plugin, { ...value, transform: rebased, from, to });
      } else {
        rebased.setMeta(plugin, value);
      }
    }
    return rebased;
  }

  private applyDispatch(transaction: Transaction, isolate: boolean): void {
    isolate ||= transaction.getMeta('uiEvent') === 'paste' || transaction.getMeta('uiEvent') === 'drop';
    const previousDoc = this.state.doc;
    this.applyTransaction(transaction, isolate);
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
        this.writeText(edit, source);
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

  private writeText(edit: ISingleEditOperation, source: string): void {
    const model = this.textModel;
    const version = model.getVersionId() + 1;
    this.writingVersions.set(version, { source, edit });
    try {
      this.writeEdit(edit);
    } finally {
      if (model.getVersionId() < version) {
        this.writingVersions.delete(version);
      }
    }
  }

  private matchesWrite(event: IModelContentChangedEvent, edit: ISingleEditOperation): boolean {
    if (event.isFlush || event.changes.length !== 1 || event.changes[0].text !== edit.text) {
      return false;
    }
    const { range } = event.changes[0];
    return range.startLineNumber === edit.range.startLineNumber && range.startColumn === edit.range.startColumn
      && range.endLineNumber === edit.range.endLineNumber && range.endColumn === edit.range.endColumn;
  }

  private applyTransaction(transaction: Transaction, isolate: boolean, externalMap?: StepMap): void {
    isolate &&= transaction.docChanged;
    this.applyState(isolate ? closeHistory(transaction) : transaction, externalMap);
    if (isolate) {
      this.applyState(closeHistory(this.state.tr));
    }
  }

  private applyState(transaction: Transaction, externalMap?: StepMap): void {
    const { state, transactions } = this.state.applyTransaction(transaction);
    this.state = state;
    for (const { owner, mapping } of this.deferred.pending) {
      if (owner === this && mapping) {
        transactions.forEach((applied, index) => {
          if (index === 0 && externalMap) {
            mapping.appendMap(externalMap);
          } else {
            mapping.appendMapping(applied.mapping);
          }
        });
      }
    }
  }

  /** `event` is left out when its changes do not lead from `lastSource` to `next`. */
  private readText(event: IModelContentChangedEvent | undefined, next: string, expectedWrite?: string): void {
    // If the writer changed the edit, the rich state represents the intended text. The event's
    // ranges describe a different starting text, so use a full parse for the actual result.
    const previous = expectedWrite ?? this.lastSource;
    if (next === previous) {
      return;
    }
    const { state } = this;
    const source = (event && expectedWrite === undefined ? this.updatePlainParagraph(event, next) : undefined) ?? parseSource(next);
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
    // History needs the full replacement above to retain source snapshots. Deferred edits need
    // only the changed positions.
    const externalMap = this.deferred.pending.length === 0 ? undefined
      : start === null || end === null ? StepMap.empty
      : sourceChangeMap(state.doc, doc, start, end, event?.changes.length ?? 1);
    this.applyTransaction(transaction, true, externalMap);
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
