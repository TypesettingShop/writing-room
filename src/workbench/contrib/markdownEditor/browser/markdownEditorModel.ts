import { closeHistory, history, isHistoryTransaction, redo, redoDepth, undo, undoDepth } from 'prosemirror-history';
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import { Mapping, StepMap } from 'prosemirror-transform';
import type { Step } from 'prosemirror-transform';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { getOriginalMarkdown, parseMarkdownWithSource } from '../../../../editor/common/markdown/parser.js';
import type { IMarkdownSourceBlock, IParsedMarkdown } from '../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../editor/common/markdown/serializer.js';
import { getTextModelEdit } from '../../../../editor/common/model.js';
import type { IModelContentChange, IModelContentChangedEvent, ISingleEditOperation, ITextModel } from '../../../../editor/common/model.js';
import {
  authorMarkdownCaretParagraph, isEmptyMarkdownCaretParagraph, markdownCaretParagraphKey, markdownCaretParagraphSide,
} from './markdownEditorSelection.js';

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

/**
 * A new empty top-level paragraph writes no Markdown, but it would still shift the serializer's block
 * alignment and so the source gaps it keeps. Omit newly added trailing paragraphs and empty
 * pointer caret paragraphs so that creating a caret does not rewrite or dirty the file.
 */
function withoutUnwrittenParagraphs(doc: Node, source: Node): Node {
  const blocks = doc.content.content.filter(node => !isEmptyMarkdownCaretParagraph(node));
  let content = blocks.length && blocks.length !== doc.childCount ? Fragment.fromArray(blocks) : doc.content;
  let parsed: Set<Node> | undefined;
  while (content.childCount > 1) {
    const last = content.lastChild!;
    if (last.type.name !== 'paragraph' || last.childCount !== 0) break;
    parsed ??= new Set(source.content.content);
    if (parsed.has(last)) break;
    content = content.cut(0, content.size - last.nodeSize);
  }
  return content === doc.content ? doc : doc.copy(content);
}

interface CaretParagraph {
  readonly pos: number;
  readonly node: Node;
  readonly side: -1 | 1;
}

function selectedCaretParagraph(state: EditorState): CaretParagraph | undefined {
  const { $head } = state.selection;
  const side = markdownCaretParagraphSide($head.parent);
  if ($head.depth === 1 && side !== undefined) {
    return { pos: $head.before(), node: $head.parent, side };
  }
}

/** Find the same source block and return the boundary on the originally clicked side. */
function remapCaretGap(
  caret: CaretParagraph, oldDoc: Node, newDoc: Node,
  before?: IParsedMarkdown, matches?: ReadonlyMap<IMarkdownSourceBlock, SourceBlockMatch | null>,
): number | undefined {
  const $gap = oldDoc.resolve(caret.pos);
  const target = caret.side === 1 ? $gap.nodeBefore : $gap.nodeAfter;
  if (!target) return;
  const from = caret.side === 1 ? caret.pos - target.nodeSize : caret.pos;
  const oldBlock = before?.blocks.find(block => block.from === from);
  if (oldBlock && matches) {
    const match = matches.get(oldBlock)?.block;
    const updated = match && newDoc.nodeAt(match.from);
    if (match && updated && (target.isLeaf ? updated.type === target.type : target.eq(updated))) {
      return caret.side === 1 ? match.to : match.from;
    }
    return;
  }

  // A flush or a skipped version has no trustworthy ranges. A unique equal block can still
  // be found anywhere. Repeated blocks must also lie in an unchanged prefix or suffix.
  let oldCount = 0;
  let newCount = 0;
  let candidate = 0;
  oldDoc.forEach(node => { if (node.eq(target)) oldCount++; });
  newDoc.forEach((node, pos) => {
    if (node.eq(target)) {
      newCount++;
      candidate = pos;
    }
  });
  if (oldCount !== newCount) return;
  if (newCount > 1) {
    const start = oldDoc.content.findDiffStart(newDoc.content);
    const end = oldDoc.content.findDiffEnd(newDoc.content);
    if (start === null || from + target.nodeSize <= start) {
      candidate = from;
    } else if (end && from >= end.a) {
      candidate = from + end.b - end.a;
    } else {
      return;
    }
  }
  const updated = newDoc.nodeAt(candidate);
  if (updated && target.eq(updated)) {
    return caret.side === 1 ? candidate + target.nodeSize : candidate;
  }
}

function appendChangedRange(ranges: number[], start: number, end: { a: number; b: number }): void {
  // Equal prefixes and suffixes can overlap for repeated text.
  const overlap = Math.max(0, start - Math.min(end.a, end.b));
  ranges.push(start, end.a + overlap - start, end.b + overlap - start);
}

// A deferred edit inside a temporarily detached caret can skip the source changes
// between this removal and its mirrored reinsertion.
class CaretParagraphRemovalMap extends StepMap {}

class SourceBatchMap extends StepMap {
  constructor(ranges: number[], private readonly unmatched: readonly { from: number; to: number }[]) {
    super(ranges);
  }

  conflicts(from: number, to: number): boolean {
    return this.unmatched.some(gap => from === to
      ? gap.from <= from && from < gap.to
      : gap.from < to && from < gap.to);
  }
}

interface SourceBlockMatch {
  readonly block: IMarkdownSourceBlock;
  readonly intact: boolean;
}

function sourceBlockMatches(
  before: IParsedMarkdown, after: IParsedMarkdown, previous: string, next: string, changes: readonly IModelContentChange[],
): ReadonlyMap<IMarkdownSourceBlock, SourceBlockMatch | null> | undefined {
  const forward = new Map<IMarkdownSourceBlock, SourceBlockMatch | null>();
  const backward = new Map<IMarkdownSourceBlock, IMarkdownSourceBlock | null>();
  const ordered = (blocks: readonly IMarkdownSourceBlock[]) =>
    blocks.every((block, index) => index === 0 || blocks[index - 1].endOffset <= block.startOffset);
  if (!ordered(before.blocks) || !ordered(after.blocks)) {
    return;
  }
  let oldIndex = 0;
  let newIndex = 0;
  let oldStart = 0;
  let newStart = 0;
  const matchUnchanged = (end: number) => {
    const shift = newStart - oldStart;
    // Walk the parser's ranges over the unchanged text in both versions, in source order.
    while (oldIndex < before.blocks.length && newIndex < after.blocks.length) {
      const oldBlock = before.blocks[oldIndex];
      const newBlock = after.blocks[newIndex];
      const oldEnd = oldBlock.endOffset;
      const newEnd = newBlock.endOffset - shift;
      const from = Math.max(oldStart, oldBlock.startOffset, newBlock.startOffset - shift);
      const to = Math.min(end, oldEnd, newEnd);
      // Line endings or indentation alone cannot establish that a block survived.
      if (from < to && /\S/.test(previous.slice(from, to))) {
        const existing = forward.get(oldBlock);
        if (existing === undefined) {
          const intact = from === oldBlock.startOffset && from === newBlock.startOffset - shift && to === oldEnd && to === newEnd;
          forward.set(oldBlock, { block: newBlock, intact });
        } else if (existing && existing.block !== newBlock) {
          forward.set(oldBlock, null);
        }
        if (backward.get(newBlock) !== oldBlock) {
          backward.set(newBlock, backward.has(newBlock) ? null : oldBlock);
        }
      }
      if (oldEnd >= end && newEnd >= end) {
        break;
      }
      if (oldEnd <= newEnd) oldIndex++;
      if (newEnd <= oldEnd) newIndex++;
    }
  };

  // Edits are reported from the end of the old document. Walk them in the opposite order.
  for (let index = changes.length - 1; index >= 0; index--) {
    const { rangeOffset, rangeLength, text } = changes[index];
    const newEnd = newStart + rangeOffset - oldStart;
    if (rangeOffset < oldStart || previous.slice(oldStart, rangeOffset) !== next.slice(newStart, newEnd) ||
        !next.startsWith(text, newEnd)) {
      return;
    }
    matchUnchanged(rangeOffset);
    oldStart = rangeOffset + rangeLength;
    newStart = newEnd + text.length;
  }
  if (previous.slice(oldStart) !== next.slice(newStart)) {
    return;
  }
  matchUnchanged(previous.length);
  // A split or merge has surviving text in more than one block on at least one side.
  for (const [oldBlock, match] of forward) {
    if (match && backward.get(match.block) !== oldBlock) {
      forward.delete(oldBlock);
    }
  }
  return forward;
}

function sourceBatchChangeMap(
  doc: Node, before: IParsedMarkdown, after: IParsedMarkdown,
  matches?: ReadonlyMap<IMarkdownSourceBlock, SourceBlockMatch | null>,
): StepMap {
  const oldBlocks = new Map(before.blocks.map(block => [block.from, block]));
  const newNodes = new Map<number, Node>();
  after.doc.forEach((node, offset) => newNodes.set(offset, node));
  const ranges: number[] = [];
  const unmatched: { from: number; to: number }[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  const appendGap = (oldTo: number, newTo: number) => {
    if (oldTo !== oldEnd || newTo !== newEnd) {
      ranges.push(oldEnd, oldTo - oldEnd, newTo - newEnd);
      unmatched.push({ from: oldEnd, to: oldTo });
    }
  };
  doc.forEach((block, offset) => {
    const source = oldBlocks.get(offset);
    const match = source && matches?.get(source);
    if (!match) {
      return;
    }
    const updated = newNodes.get(match.block.from)!;
    // Equal containers can still have moved children when the batch edits their source.
    if (!block.sameMarkup(updated) || (!block.isTextblock && !(match.intact && block.eq(updated)))) {
      return;
    }
    appendGap(offset, match.block.from);
    const from = block.content.findDiffStart(updated.content, offset + 1);
    const to = block.content.findDiffEnd(updated.content, offset + 1 + block.content.size, offset + 1 + updated.content.size);
    if (from !== null && to !== null) {
      appendChangedRange(ranges, from, to);
    }
    oldEnd = offset + block.nodeSize;
    newEnd = match.block.to;
  });
  appendGap(doc.content.size, after.doc.content.size);
  return unmatched.length ? new SourceBatchMap(ranges, unmatched) : new StepMap(ranges);
}

function mapDeferredStep(step: Step, remap: Mapping, start: number): Step | null {
  const mapping = remap.slice(start);
  let firstBatch = start;
  while (firstBatch < remap.to && !(remap.maps[firstBatch] instanceof SourceBatchMap)) {
    firstBatch++;
  }
  if (firstBatch === remap.to) {
    return step.map(mapping);
  }
  // Steps can map successfully even if they cross an unmatched block or land exactly on
  // its boundaries. Check the positions requested by the step in each batch's old document.
  const positions: { pos: number; assoc: number }[] = [];
  const mapped = step.map({
    map(pos, assoc = 1) {
      positions.push({ pos, assoc });
      return mapping.map(pos, assoc);
    },
    mapResult(pos, assoc = 1) {
      positions.push({ pos, assoc });
      return mapping.mapResult(pos, assoc);
    },
  });
  if (!mapped) {
    return null;
  }
  let removedCaret: number | undefined;
  for (let index = start; index < remap.to; index++) {
    const batch = remap.maps[index];
    if (batch instanceof CaretParagraphRemovalMap) removedCaret = index;
    if (!(batch instanceof SourceBatchMap)) continue;
    if (removedCaret !== undefined && (remap.getMirror(removedCaret) ?? -1) > index) {
      const beforeCaret = remap.slice(start, removedCaret);
      const removal = remap.maps[removedCaret];
      if (positions.every(({ pos, assoc }) => removal.mapResult(beforeCaret.map(pos, assoc), assoc).deletedAcross)) {
        continue;
      }
    }
    const before = remap.slice(start, index);
    let from = Infinity;
    let to = -Infinity;
    for (const { pos, assoc } of positions) {
      const point = before.map(pos, assoc);
      from = Math.min(from, point);
      to = Math.max(to, point);
    }
    if (batch.conflicts(from, to)) {
      return null;
    }
  }
  return mapped;
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
    beforeExternalChange?: () => void,
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
      const ownWrite = this.writingVersions.get(event.versionId);
      if (beforeExternalChange && (!ownWrite || !this.matchesWrite(event, ownWrite.edit))) {
        // Flush local input against the document that the editor still displays. Its transactions
        // wait for this source version and rebase through the existing deferred edit queue.
        try {
          beforeExternalChange();
        } catch (error) {
          // The source has already changed, so keep syncing even if the view fails to flush.
          console.error(error);
        }
        if (event.versionId <= this.version) {
          return;
        }
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
    if (isHistoryTransaction(transaction)) {
      // Recompute native beforeinput history against the current source and without a temporary caret.
      this.runCommand(transaction.getMeta(markdownHistory).redo ? redo : undo);
      return;
    }
    if (!this.shouldDeferEdit()) {
      this.applyDispatch(transaction, isolate);
      return;
    }
    const before = this.state;
    const mapping = new Mapping();
    this.deferred.pending.push({ owner: this, mapping, run: () => {
      const rebased = before === this.state && mapping.maps.length === 0 ? transaction : this.rebaseTransaction(transaction, mapping);
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
    const run = () => {
      const caret = command === undo || command === redo ? selectedCaretParagraph(this.state) : undefined;
      if (caret && command(this.state)) {
        const mapping = new Mapping();
        this.removeCaretParagraph(caret, mapping);
        this.mapDeferredEdits(mapping);
      }
      return command(this.state, transaction => this.applyDispatch(transaction, isolate));
    };
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
      const step = mapDeferredStep(transaction.steps[index], remap, transaction.steps.length - index);
      if (!step || rebased.maybeStep(step).failed) {
        return;
      }
      remap.appendMap(step.getMap(), transaction.steps.length - 1 - index);
    }
    this.copyTransactionState(transaction, rebased, remap.slice(), over);
    return rebased;
  }

  private copyTransactionState(
    transaction: Transaction, copy: Transaction, selection: Mapping, over: Mapping, inputRulesTransform = copy,
  ): void {
    if (transaction.selectionSet) {
      copy.setSelection(transaction.selection.map(copy.doc, selection));
    }
    if (transaction.storedMarksSet) {
      copy.setStoredMarks(transaction.storedMarks);
    }
    if (transaction.scrolledIntoView) {
      copy.scrollIntoView();
    }
    const caret = transaction.getMeta(markdownCaretParagraphKey);
    if (caret) copy.setMeta(markdownCaretParagraphKey, true);
    for (const key of ['addToHistory', 'uiEvent', 'paste', 'pointer', 'composition']) {
      const value = transaction.getMeta(key);
      if (value !== undefined) {
        copy.setMeta(key, value);
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
        copy.setMeta(plugin, { ...value, transform: inputRulesTransform, from, to });
      } else {
        copy.setMeta(plugin, value);
      }
    }
  }

  private removeCaretParagraph(caret: CaretParagraph, mapping: Mapping): void {
    const tr = this.state.tr.delete(caret.pos, caret.pos + caret.node.nodeSize);
    const gap = tr.doc.resolve(caret.pos);
    const { selection, storedMarks } = this.state;
    if (selection.empty) {
      tr.setSelection(TextSelection.between(gap, gap, caret.side));
      if (storedMarks && tr.selection.$head.parent.inlineContent) tr.setStoredMarks(storedMarks);
    }
    const removal = new CaretParagraphRemovalMap([caret.pos, caret.node.nodeSize, 0]);
    this.applyState(tr.setMeta('addToHistory', false), mapping, { map: removal });
  }

  private removeUnusedCaretParagraphs(mapping: Mapping): void {
    const { state } = this;
    const active = selectedCaretParagraph(state);
    const tr = state.tr;
    state.doc.forEach((node, pos) => {
      if (pos !== active?.pos && isEmptyMarkdownCaretParagraph(node)) {
        const from = tr.mapping.map(pos);
        tr.delete(from, from + node.nodeSize);
      }
    });
    if (!tr.docChanged) return;
    const { selection } = state;
    if (selection instanceof TextSelection && !selection.empty) {
      const anchor = tr.doc.resolve(tr.mapping.map(selection.anchor));
      const head = tr.doc.resolve(tr.mapping.map(selection.head));
      // Keep an extended selection when its old anchor was inside the retired paragraph.
      const outside = anchor.parent.inlineContent ? anchor
        : Selection.findFrom(anchor, selection.anchor < selection.head ? -1 : 1, true)?.$head ?? anchor;
      tr.setSelection(TextSelection.between(outside, head));
    }
    this.applyState(tr.setMeta('addToHistory', false), mapping);
  }

  private editsCaretParagraph(transaction: Transaction, caret: CaretParagraph): boolean {
    const { doc, mapping } = transaction;
    const inside = caret.pos + 1;
    return doc.nodeAt(mapping.map(caret.pos, 1)) !== caret.node
      || mapping.map(inside, -1) !== mapping.map(inside, 1);
  }

  private applyDispatch(transaction: Transaction, isolate: boolean): void {
    isolate ||= transaction.getMeta('uiEvent') === 'paste' || transaction.getMeta('uiEvent') === 'drop';
    const previousDoc = this.state.doc;
    const caret = selectedCaretParagraph(this.state);
    const mapping = new Mapping();
    let displayOnly = transaction.getMeta(markdownCaretParagraphKey) === true;
    let firstMap: { map: StepMap; mirror?: number } | undefined;
    if (caret && transaction.docChanged && !displayOnly && this.editsCaretParagraph(transaction, caret)) {
      displayOnly = withoutUnwrittenParagraphs(previousDoc, this.sourceDoc.doc)
        .eq(withoutUnwrittenParagraphs(transaction.doc, this.sourceDoc.doc));
      if (displayOnly) {
        transaction.setMeta('addToHistory', false);
      } else {
        // History starts with the authored insertion. Undo can remove the whole paragraph,
        // and Redo has an insertion to replay even after the cursor has moved.
        this.removeCaretParagraph(caret, mapping);
        authorMarkdownCaretParagraph(caret.node);
        const authored = this.state.tr.insert(caret.pos, caret.node).setTime(transaction.time);
        for (const step of transaction.steps) authored.step(step);
        const identity = new Mapping();
        this.copyTransactionState(transaction, authored, identity, identity, transaction);
        if (!transaction.selectionSet) authored.setSelection(transaction.selection.map(authored.doc, identity));
        transaction = closeHistory(authored);
        firstMap = { map: authored.mapping.maps[0], mirror: 0 };
      }
    }
    this.applyTransaction(transaction, isolate && !displayOnly, mapping, firstMap);
    const changedDocument = this.state.doc !== previousDoc;
    if (caret || displayOnly) this.removeUnusedCaretParagraphs(mapping);
    this.mapDeferredEdits(mapping);
    if (changedDocument && !displayOnly) {
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

  private serializeDocument(edited: Node): string {
    const source = this.sourceDoc;
    const doc = withoutUnwrittenParagraphs(edited, source.doc);
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

  private applyTransaction(
    transaction: Transaction, isolate: boolean, mapping: Mapping, firstMap?: { map: StepMap; mirror?: number },
  ): void {
    isolate &&= transaction.docChanged;
    this.applyState(isolate ? closeHistory(transaction) : transaction, mapping, firstMap);
    if (isolate) {
      this.applyState(closeHistory(this.state.tr), mapping);
    }
  }

  private applyState(transaction: Transaction, mapping: Mapping, firstMap?: { map: StepMap; mirror?: number }): void {
    const { state, transactions } = this.state.applyTransaction(transaction);
    this.state = state;
    for (const applied of transactions) {
      if (applied === transaction && firstMap) {
        mapping.appendMap(firstMap.map, firstMap.mirror);
        mapping.appendMapping(applied.mapping.slice(1));
      } else {
        mapping.appendMapping(applied.mapping);
      }
    }
  }

  private mapDeferredEdits(change: Mapping): void {
    for (const { owner, mapping } of this.deferred.pending) {
      if (owner === this && mapping) {
        mapping.appendMapping(change);
      }
    }
  }

  /** `event` is left out when its changes do not lead from `lastSource` to `next`. */
  private readText(event: IModelContentChangedEvent | undefined, next: string, expectedWrite?: string): void {
    // If the writer changed the edit, the rich state represents the intended text. The event's
    // ranges describe a different starting text, so use a full parse for the actual result.
    const previous = expectedWrite ?? this.lastSource;
    const hasDeferredMapping = this.deferred.pending.some(edit => edit.owner === this && edit.mapping);
    const changes = expectedWrite === undefined && event && !event.isFlush ? event.changes : undefined;
    const caret = selectedCaretParagraph(this.state);
    const batch = (hasDeferredMapping || caret) && changes && changes.length > 1 ? changes : undefined;
    if (next === previous && !batch) {
      return;
    }
    const updatedSource = next === previous ? this.sourceDoc
      : (event && expectedWrite === undefined ? this.updatePlainParagraph(event, next) : undefined) ?? parseSource(next);
    const mapping = new Mapping();
    const { selection, storedMarks } = this.state;
    // The source change's history snapshots contain only source blocks. If its anchor survives,
    // restore the temporary paragraph at the new gap after recording the external edit.
    if (caret) this.removeCaretParagraph(caret, mapping);
    const { state } = this;
    const doc = next === previous ? state.doc : updatedSource.doc;
    let before: IParsedMarkdown | undefined;
    let matches: ReadonlyMap<IMarkdownSourceBlock, SourceBlockMatch | null> | undefined;
    let externalMap: StepMap | undefined;
    if (changes && (batch || caret)) {
      const original = getOriginalMarkdown(this.sourceDoc.doc);
      // A rich write or incremental paragraph edit may have left older parser ranges.
      const parsed = original?.source === previous ? original.parsed : parseMarkdownWithSource(previous);
      const after = next === previous ? parsed : getOriginalMarkdown(doc)?.parsed ?? parseMarkdownWithSource(next);
      if (state.doc.eq(parsed.doc)) {
        before = parsed;
        matches = sourceBlockMatches(parsed, after, previous, next, changes);
      }
      if (hasDeferredMapping && batch) {
        externalMap = sourceBatchChangeMap(state.doc, parsed, after, matches);
      }
    }
    const caretGap = caret && remapCaretGap(caret, state.doc, doc, before, matches);
    let afterSource = mapping.maps.length;
    if (next !== previous) {
      this.snapshots.set(state.doc.content, { text: previous, provenance: this.sourceDoc });
      this.lastSource = next;
      this.sourceDoc = updatedSource;
      this.serializerProvenance = undefined;
      const start = state.doc.content.findDiffStart(doc.content);
      const end = state.doc.content.findDiffEnd(doc.content);
      const ranges: number[] = [];
      if (start !== null && end !== null) appendChangedRange(ranges, start, end);
      const diff = new StepMap(ranges);
      // Keep the exact source fragments in history, including spelling-only changes.
      // Queued rich edits and the visible selection should move by the changed positions.
      const transaction = state.tr.replaceWith(0, state.doc.content.size, doc.content);
      this.snapshots.set(transaction.doc.content, { text: next, provenance: updatedSource });
      if (caret && selection.empty) {
        const gap = transaction.doc.resolve(diff.map(caret.pos, caret.side === 1 ? -1 : 1));
        transaction.setSelection(TextSelection.between(gap, gap, caret.side));
      } else {
        const map = (pos: number) => {
          if (start === null || end === null || pos <= start) return pos;
          return pos >= end.a ? Math.max(start, pos + end.b - end.a) : Math.max(start, end.b);
        };
        const anchor = transaction.doc.resolve(map(state.selection.anchor));
        const head = transaction.doc.resolve(map(state.selection.head));
        transaction.setSelection(TextSelection.between(anchor, head));
      }
      afterSource++;
      this.applyTransaction(transaction, true, mapping, { map: externalMap ?? diff });
    } else if (externalMap) {
      // Identical text can hide a batch that removed one copy and left another in its place.
      // Rebase without adding a no-op source step to history.
      mapping.appendMap(externalMap);
      afterSource++;
    }
    if (caret && caretGap !== undefined) {
      const gap = mapping.slice(afterSource).map(caretGap, caret.side === 1 ? -1 : 1);
      const tr = this.state.tr.insert(gap, caret.node);
      const anchor = selection.empty ? gap + 1 : tr.mapping.map(mapping.map(selection.anchor));
      tr.setSelection(TextSelection.between(tr.doc.resolve(anchor), tr.doc.resolve(gap + 1)));
      if (storedMarks && tr.selection.empty) tr.setStoredMarks(storedMarks);
      // Mirror removal and reinsertion so an edit flushed by the DOM observer still targets
      // the inside of this paragraph. With no surviving anchor, that edit maps to a deletion.
      this.applyState(tr.setMeta('addToHistory', false), mapping, { map: tr.mapping.maps[0], mirror: 0 });
    }
    this.mapDeferredEdits(mapping);
    if (next !== previous || caret) this.onStateChange(this.state);
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
