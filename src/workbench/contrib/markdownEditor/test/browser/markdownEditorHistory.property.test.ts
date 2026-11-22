import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { redoDepth, undoDepth } from 'prosemirror-history';
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { parseMarkdownWithSource } from '../../../../../editor/common/markdown/parser.js';
import type { IModelContentChangedEvent, IPosition } from '../../../../../editor/common/model.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { MarkdownEditorModel } from '../../browser/markdownEditorModel.js';
import {
  createMarkdownCaretParagraph, isEmptyMarkdownCaretParagraph, markdownCaretParagraphKey, markdownCaretParagraphSide,
} from '../../browser/markdownEditorSelection.js';

function random(seed: number): () => number {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
}

function textPositions(doc: Node): number[] {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      for (let offset = 0; offset <= node.content.size; offset++) {
        positions.push(pos + 1 + offset);
      }
      return false;
    }
    return true;
  });
  return positions;
}

/** Use the LF fixture's edit and event machinery with CRLF line and offset coordinates. */
class CRLFHistoryModel extends TestTextModel {
  override getEOL(): string { return '\r\n'; }
  override getLinesContent(): string[] { return this.getValue().split(this.getEOL()); }

  override getOffsetAt(position: IPosition): number {
    const line = Math.min(Math.max(position.lineNumber, 1), this.getLineCount());
    return super.getOffsetAt(position) + line - 1;
  }

  override getPositionAt(offset: number): IPosition {
    const prefix = this.getValue().slice(0, Math.max(0, offset));
    return super.getPositionAt(prefix.replaceAll('\r', '').length);
  }

  override onDidChangeContent(listener: (event: IModelContentChangedEvent) => void) {
    return super.onDidChangeContent(event => listener({ ...event, eol: this.getEOL() }));
  }
}

function exerciseHistory(seed: number, paneCount: number, exactSource: boolean, gap?: string): void {
  const nextRandom = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(nextRandom() * values.length)];
  const source = ['First', 'Middle', 'Last'].join(gap ?? '\n\n');
  const uri = URI.parse('file:///history.md');
  const model = gap?.includes('\r') ? new CRLFHistoryModel(uri, source) : new TestTextModel(uri, source);
  const separator = model.getEOL().repeat(2);
  const panes: MarkdownEditorModel[] = [];
  const trace: string[] = [];
  let depth = 0;
  let recording = true;
  let time = 1000;
  let recordedVersion = model.getVersionId();
  let recordedText = model.getValue();
  const writtenTexts = new Set([recordedText]);
  const events = new Map<number, IModelContentChangedEvent>();
  let paragraphMove: { version: number; dispatch: () => void } | undefined;
  // Listeners may receive v4 before v3 and reading getValue in the v3 callback can return v4.
  // Record the actual text of every version by replaying the text model's changes in version order.
  model.onDidChangeContent(event => {
    if (recording) {
      events.set(event.versionId, event);
    }
  });

  function moveParagraphs(pane: MarkdownEditorModel): boolean {
    const paragraphs = model.getValue().split('\n\n');
    if (paragraphs.length < 2 || !paragraphs.every(paragraph => /^[A-Za-z]+(?: [A-Za-z]+)*$/.test(paragraph))) {
      return false;
    }
    const last = paragraphs.length - 1;
    const moveUp = nextRandom() < 0.5;
    const removed = moveUp ? 0 : last;
    const target = Math.floor(nextRandom() * paragraphs.length);
    const replacement = pick(['Added', 'New', paragraphs[removed]]);
    const input = pick(['x', 'Y', 'k']);
    const expected = paragraphs.slice();
    if (target !== removed) {
      expected[target] += input;
    }
    expected.splice(removed, 1);
    expected.splice(moveUp ? last : 0, 0, replacement);

    const lastLine = last * 2 + 1;
    const lastColumn = paragraphs[last].length + 1;
    const edits = moveUp ? [
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '' },
      { range: { startLineNumber: lastLine, startColumn: lastColumn, endLineNumber: lastLine, endColumn: lastColumn },
        text: '\n\n' + replacement },
    ] : [
      { range: { startLineNumber: lastLine - 2, startColumn: paragraphs[last - 1].length + 1, endLineNumber: lastLine, endColumn: lastColumn },
        text: '' },
      { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: replacement + '\n\n' },
    ];
    const position = paragraphs.slice(0, target + 1).reduce((pos, text) => pos + text.length + 2, -1);
    trace.push(`batch ${moveUp ? 'up' : 'down'} target ${target} input ${input} replacement ${replacement}`);
    paragraphMove = {
      version: model.getVersionId() + 1,
      dispatch: () => {
        time += 100;
        pane.dispatch(pane.state.tr.insertText(input, position).setTime(time));
      },
    };
    try {
      model.applyEdits(edits);
    } finally {
      paragraphMove = undefined;
    }
    // This oracle tracks which original paragraph survives. Comparing the pane with its text
    // alone would also pass if both agreed on an edit to the wrong paragraph.
    const source = expected.join('\n\n');
    if (model.getValue() !== source) {
      throw new Error(`Expected batch to leave ${JSON.stringify(source)}, got ${JSON.stringify(model.getValue())}`);
    }
    return true;
  }

  function act(): void {
    const operation = nextRandom();
    const paneIndex = Math.floor(nextRandom() * panes.length);
    const pane = panes[paneIndex];
    if (operation < 0.12 && depth === 0 && moveParagraphs(pane)) {
      return;
    }
    if (operation < 0.35) {
      const offset = Math.floor(nextRandom() * (model.getValueLength() + 1));
      let text = pick(exactSource ? ['a', 'Z', separator, 'q', 's'] : ['a', 'Z ', separator, 'q', '# ']);
      let { lineNumber, column } = model.getPositionAt(offset);
      if (exactSource) {
        // Keep one spelling per document: edit within a paragraph, or split it into two nonempty
        // paragraphs. The mixed Markdown runs also cover multiple spellings of the same document.
        if (model.getLineContent(lineNumber) === '') {
          lineNumber--;
          column = model.getLineContent(lineNumber).length + 1;
        }
        if (text === separator && (column === 1 || column > model.getLineContent(lineNumber).length)) {
          text = 's';
        }
      }
      trace.push(`source@${model.getOffsetAt({ lineNumber, column })}:${JSON.stringify(text)}`);
      model.applyEdits([{
        range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
        text,
      }]);
    } else if (operation < 0.75) {
      const positions = textPositions(pane.state.doc);
      if (positions.length > 0) {
        const pos = pick(positions);
        const text = pick(['x', 'Y', 'k']);
        trace.push(`rich${paneIndex}@${pos}:${text}`);
        time += 100;
        pane.dispatch(pane.state.tr.insertText(text, pos).setTime(time));
      }
    } else if (nextRandom() < 0.6) {
      trace.push(`undo${paneIndex}`);
      pane.undo();
    } else {
      trace.push(`redo${paneIndex}`);
      pane.redo();
    }
  }

  const listener = (label: string) => () => {
    if (recording && gap === undefined && !paragraphMove && depth < 3 && nextRandom() < 0.3) {
      trace.push(label + '[');
      depth++;
      try {
        act();
      } finally {
        depth--;
        trace.push(']');
      }
    }
  };
  model.onDidChangeContent(event => {
    if (event.versionId === paragraphMove?.version) {
      paragraphMove.dispatch();
    }
  });
  model.onDidChangeContent(listener('before panes'));
  for (let index = 0; index < paneCount; index++) {
    panes.push(new MarkdownEditorModel(model, [], () => {}));
  }
  model.onDidChangeContent(listener('after panes'));

  const check = (step: string) => {
    const source = model.getValue();
    if (recording) {
      while (recordedVersion < model.getVersionId()) {
        const event = events.get(++recordedVersion);
        if (!event) {
          throw new Error(`Missing model event ${recordedVersion}`);
        }
        for (const change of event.changes) {
          recordedText = recordedText.slice(0, change.rangeOffset) + change.text
            + recordedText.slice(change.rangeOffset + change.rangeLength);
        }
        events.delete(recordedVersion);
        writtenTexts.add(recordedText);
      }
      if (source !== recordedText) {
        throw new Error(`${step} recorded ${JSON.stringify(recordedText)}, model has ${JSON.stringify(source)}`);
      }
    } else if ((exactSource || gap !== undefined) && !writtenTexts.has(source)) {
      throw new Error(`${step} restored unwritten text ${JSON.stringify(source)}`);
    }
    const parsed = parseMarkdownWithSource(source).doc;
    for (const [index, pane] of panes.entries()) {
      if (!pane.state.doc.eq(parsed)) {
        throw new Error(`${step} pane ${index} differs from ${JSON.stringify(source)}`);
      }
    }
  };

  try {
    if (gap !== undefined) {
      // Keep the gap oracle independent of the reentrant edits. Dispatch the native split with
      // the new block's first text so every pane sees a source-backed block, then walk history.
      const pane = pick(panes);
      const middle = pane.state.doc.child(1);
      const suffix = pick(['a', 'Z', 'q']);
      const added = pick(['x', 'Y', 'k']);
      trace.push(`source then split ${JSON.stringify({ gap, suffix, added })}`);
      model.applyEdits([{
        range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 }, text: suffix,
      }]);
      expect(pane.state.doc.child(1), 'source edit reused the unchanged middle block').toBe(middle);
      const { doc } = pane.state;
      const end = doc.child(0).nodeSize + middle.nodeSize - 1;
      pane.dispatch(pane.state.tr.setSelection(TextSelection.create(doc, end)));
      expect(splitBlock(pane.state, tr => pane.dispatch(tr.insertText(added).setTime(time)))).toBe(true);
      expect(model.getValue(), 'split kept the original gap before the middle paragraph')
        .toBe('First' + suffix + gap + 'Middle' + separator + added + separator + 'Last');
      check('source then split');
    } else {
      for (let step = 0; step < 12; step++) {
        act();
        check(`step ${step}`);
      }
    }
    // Freeze the set of texts before walking history so an Undo/Redo write cannot validate itself.
    recording = false;
    for (const [index, pane] of panes.entries()) {
      for (let step = 0; pane.canUndo; step++) {
        if (step >= 200 || !pane.undo()) {
          throw new Error(`Pane ${index} could not finish Undo at step ${step}`);
        }
        check(`pane ${index} undo ${step}`);
      }
      for (let step = 0; pane.canRedo; step++) {
        if (step >= 400 || !pane.redo()) {
          throw new Error(`Pane ${index} could not finish Redo at step ${step}`);
        }
        check(`pane ${index} redo ${step}`);
      }
    }
  } catch (error) {
    throw new Error(`Seed ${seed} with ${paneCount} panes\n${trace.join(' ')}\n${error}`, { cause: error });
  } finally {
    for (const pane of panes) {
      pane.dispose();
    }
    model.dispose();
  }
}

function exerciseCaretHistory(seed: number): void {
  const nextRandom = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(nextRandom() * values.length)];
  const word = pick(['words', 'paragraph', 'text']);
  // The link definition supplies the raw_block. The HTML fixture parses as paragraph text.
  const source = [
    `First ${word}`, '---', `Middle ${word}`, '[ref]: /example', `Last ${word}`, '<div>Raw HTML</div>',
  ].join('\n\n');
  const model = new TestTextModel(URI.parse('file:///gutter-history.md'), source);
  const pane = new MarkdownEditorModel(model, [], () => {});
  // A second pane never sees the temporary paragraph and only follows written text.
  const other = new MarkdownEditorModel(model, [], () => {});
  const trace: string[] = [];
  let time = Date.now();

  const history = () => ({
    text: model.getValue(),
    version: model.getVersionId(),
    undo: undoDepth(pane.state),
    redo: redoDepth(pane.state),
  });

  function check(carets = 0, authoredAt?: number): Node {
    const { doc } = pane.state;
    const blocks = doc.content.content.filter(node => !isEmptyMarkdownCaretParagraph(node));
    expect(doc.childCount - blocks.length, 'visible temporary paragraphs').toBe(carets);
    if (authoredAt !== undefined) {
      const [authored] = blocks.splice(doc.resolve(authoredAt).index(), 1);
      expect(authored?.type.name).toBe('paragraph');
      expect(authored?.content.size, 'authored blank has no Markdown').toBe(0);
    }
    const written = doc.copy(Fragment.fromArray(blocks));
    const text = model.getValue();
    const parsed = parseMarkdownWithSource(text).doc;
    expect(written.eq(parsed), `rich document differs from ${JSON.stringify(text)}`).toBe(true);
    expect(other.state.doc.eq(parsed), 'other pane differs from the written Markdown').toBe(true);
    return written;
  }

  function display(transaction: Transaction, carets: number, authoredAt?: number): void {
    const before = history();
    const otherBefore = other.state;
    pane.dispatch(transaction);
    expect(history(), 'display-only operation changed the source or history').toEqual(before);
    expect(other.state, 'display-only operation reached the other pane').toBe(otherBefore);
    check(carets, authoredAt);
  }

  try {
    for (let step = 0; step < 12; step++) {
      const side = (seed + step) % 2 === 0 ? -1 : 1;
      const clean = check();
      const targets: number[] = [];
      clean.forEach((node, from, index) => {
        const neighbor = clean.maybeChild(index + side);
        if (node.isAtom && !node.isTextblock && neighbor?.type === clean.type.schema.nodes.paragraph
            && neighbor.content.size > 0) {
          targets.push(side === 1 ? from + node.nodeSize : from);
        }
      });
      expect(targets.length, 'source retains a gutter beside an editable paragraph').toBeGreaterThan(0);
      const gapBeforeChange = pick(targets);
      trace.push(`gutter ${side}@${gapBeforeChange}`);
      const paragraph = createMarkdownCaretParagraph(pane.state.schema.nodes.paragraph, side);
      const gutter = pane.state.tr.insert(gapBeforeChange, paragraph);
      display(gutter.setSelection(TextSelection.create(gutter.doc, gapBeforeChange + 1))
        .setMeta(markdownCaretParagraphKey, true).setMeta('addToHistory', false), 1);

      let gap = gapBeforeChange;
      if (nextRandom() < 0.35) {
        // Insert into the first line, before the gap, or into the last line, after it. A rewrite
        // replaces the whole text in one edit, as a reload diff does, with the first-line insert.
        const kind = pick(['before', 'after', 'rewrite'] as const);
        const line = kind === 'after' ? model.getLineCount() : 1;
        const content = model.getLineContent(line);
        const column = 1 + Math.floor(nextRandom() * (content.length + 1));
        const text = pick(['a', 'X', 'z']);
        trace.push(`source:${kind}@${line}:${column}+${text}`);
        const before = history();
        const offset = model.getOffsetAt({ lineNumber: line, column });
        const next = before.text.slice(0, offset) + text + before.text.slice(offset);
        const lastLine = model.getLineCount();
        model.applyEdits([kind === 'rewrite'
          ? {
            range: { startLineNumber: 1, startColumn: 1, endLineNumber: lastLine, endColumn: model.getLineContent(lastLine).length + 1 },
            text: next,
          }
          : { range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text }]);
        expect(model.getValue()).toBe(next);
        expect(model.getVersionId()).toBe(before.version + 1);
        expect(undoDepth(pane.state)).toBe(before.undo + 1);
        if (kind !== 'after') gap += text.length;
        check(1);
        expect(pane.state.selection.head, 'external edit preserved the gap').toBe(gap + 1);
      }
      expect(markdownCaretParagraphSide(pane.state.selection.$head.parent)).toBe(side);

      const docBeforeInput = check(1);
      const placeInView = (pos: number) => pos > gap ? pos + paragraph.nodeSize : pos;
      const edge = gap + side;
      const neighbor = docBeforeInput.resolve(edge).parent;
      const inside = edge + side * (1 + Math.floor(nextRandom() * neighbor.content.size));
      const operation = pick(['move', 'extend', 'replace', 'type', 'enter'] as const);
      trace.push(`${operation}@${inside}`);

      if (operation === 'move') {
        const to = pick(textPositions(docBeforeInput));
        display(pane.state.tr.setSelection(TextSelection.create(pane.state.doc, placeInView(to))), 0);
        expect(pane.state.selection.head).toBe(to);
        continue;
      }
      if (operation === 'extend') {
        display(pane.state.tr.setSelection(TextSelection.create(pane.state.doc, gap + 1, placeInView(inside))), 0);
        expect(pane.state.selection.anchor, 'range starts on the clicked side of the atom').toBe(edge);
        expect(pane.state.selection.head).toBe(inside);
        continue;
      }
      if (operation === 'enter') {
        const before = history();
        const otherBefore = other.state;
        const after = { ...before, undo: before.undo + 1, redo: 0 };
        const checkEnter = () => {
          check(1, gap);
          expect(history(), 'only the undo history changed').toEqual(after);
          expect(other.state, 'the other pane sees only written Markdown').toBe(otherBefore);
          expect(pane.state.selection.head).toBe(gap + paragraph.nodeSize + 1);
          expect(markdownCaretParagraphSide(pane.state.selection.$head.parent)).toBe(side);
        };
        expect(baseKeymap.Enter(pane.state, tr => pane.dispatch(tr))).toBe(true);
        checkEnter();
        if (nextRandom() < 0.5) {
          display(pane.state.tr.setSelection(TextSelection.create(pane.state.doc, 1)), 0, gap);
        }
        expect(pane.undo()).toBe(true);
        expect(check().eq(docBeforeInput)).toBe(true);
        expect(history()).toEqual({ ...before, redo: 1 });
        expect(pane.redo()).toBe(true);
        checkEnter();
        expect(pane.undo()).toBe(true);
        expect(check().eq(docBeforeInput)).toBe(true);
        continue;
      }

      const from = Math.min(inside, edge);
      const to = Math.max(inside, edge);
      const replaced = operation === 'replace' ? docBeforeInput.textBetween(from, to) : '';
      const text = pick(['x', 'Yo', 'new'].filter(candidate => candidate !== replaced));
      // Apply the generated edit directly to the source-backed document to predict its position.
      const expected = new Transform(docBeforeInput);
      if (operation === 'replace') {
        const selection = TextSelection.create(pane.state.doc, placeInView(inside), gap + 1);
        display(pane.state.tr.setSelection(selection), 1);
        expected.replaceWith(from, to, pane.state.schema.text(text));
      } else {
        expected.insert(gap, pane.state.schema.nodes.paragraph.create(null, pane.state.schema.text(text)));
      }

      const before = history();
      // Each generated edit starts after the preceding typing group has elapsed.
      time = Math.max(time, Date.now()) + 1000;
      pane.dispatch(pane.state.tr.insertText(text).setTime(time));
      expect(check().eq(expected.doc), 'input changed the generated text range').toBe(true);
      const written = history();
      expect(written.undo, 'input is one undo step').toBe(before.undo + 1);
      expect(written.version).toBe(before.version + 1);
      expect(pane.undo()).toBe(true);
      expect(check().eq(docBeforeInput)).toBe(true);
      expect(history().undo).toBe(before.undo);
      expect(model.getValue()).toBe(before.text);
      if (operation === 'replace') {
        expect(pane.state.selection, 'undo restores a text range').toBeInstanceOf(TextSelection);
        expect(pane.state.selection.anchor).toBe(inside);
        expect(pane.state.selection.head).toBe(edge);
      }

      const redoFrom = pick(textPositions(docBeforeInput));
      display(pane.state.tr.setSelection(TextSelection.create(pane.state.doc, redoFrom)), 0);
      expect(pane.redo()).toBe(true);
      expect(check().eq(expected.doc)).toBe(true);
      expect(history().undo).toBe(written.undo);
      expect(model.getValue()).toBe(written.text);
    }
  } catch (error) {
    throw new Error(`Gutter seed ${seed}\n${trace.join(' ')}\n${error}`, { cause: error });
  } finally {
    pane.dispose();
    other.dispose();
    model.dispose();
  }
}

describe('Markdown editor history across reentrant text edits', () => {
  const full = process.env.MARKDOWN_HISTORY_FULL === '1';
  const cases = [
    { paneCount: 2, exactSource: false, input: 'mixed Markdown' },
    { paneCount: 3, exactSource: false, input: 'mixed Markdown' },
    { paneCount: 2, exactSource: true, input: 'exact paragraph source' },
    { paneCount: 3, exactSource: true, input: 'exact paragraph source' },
  ];
  it.each(cases)('synchronizes $paneCount panes through $input history', { timeout: full ? 300_000 : 10_000 },
    ({ paneCount, exactSource }) => {
      if (!exactSource) {
        const gaps = ['\n\n', '\n\n\n', '\r\n\r\n\r\n', '\n\n \t\n'];
        const gapSeeds = full ? 24 : gaps.length;
        for (let seed = 1; seed <= gapSeeds; seed++) {
          exerciseHistory(seed, paneCount, exactSource, gaps[(seed - 1) % gaps.length]);
        }
      }
      const seeds = full ? (paneCount === 2 ? 600 : 1500) : 24;
      for (let seed = 1; seed <= seeds; seed++) {
        exerciseHistory(seed, paneCount, exactSource);
      }
    });

  it('synchronizes gutter caret history with the written Markdown', { timeout: full ? 300_000 : 10_000 }, () => {
    const seeds = full ? 600 : 24;
    for (let seed = 1; seed <= seeds; seed++) exerciseCaretHistory(seed);
  });
});
