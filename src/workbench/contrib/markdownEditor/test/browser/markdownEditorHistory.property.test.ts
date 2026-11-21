import type { Node } from 'prosemirror-model';
import { describe, it } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { parseMarkdownWithSource } from '../../../../../editor/common/markdown/parser.js';
import type { IModelContentChangedEvent } from '../../../../../editor/common/model.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { MarkdownEditorModel } from '../../browser/markdownEditorModel.js';

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

function exerciseHistory(seed: number, paneCount: number, exactSource: boolean): void {
  const nextRandom = random(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(nextRandom() * values.length)];
  const model = new TestTextModel(URI.parse('file:///history.md'), 'First\n\nMiddle\n\nLast');
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
      let text = pick(exactSource ? ['a', 'Z', '\n\n', 'q', 's'] : ['a', 'Z ', '\n\n', 'q', '# ']);
      let { lineNumber, column } = model.getPositionAt(offset);
      if (exactSource) {
        // Keep one spelling per document: edit within a paragraph, or split it into two nonempty
        // paragraphs. The mixed Markdown runs also cover multiple spellings of the same document.
        if (model.getLineContent(lineNumber) === '') {
          lineNumber--;
          column = model.getLineContent(lineNumber).length + 1;
        }
        if (text === '\n\n' && (column === 1 || column > model.getLineContent(lineNumber).length)) {
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
    if (recording && !paragraphMove && depth < 3 && nextRandom() < 0.3) {
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
    } else if (exactSource && !writtenTexts.has(source)) {
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
    for (let step = 0; step < 12; step++) {
      act();
      check(`step ${step}`);
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
      const seeds = full ? (paneCount === 2 ? 600 : 1500) : 24;
      for (let seed = 1; seed <= seeds; seed++) {
        exerciseHistory(seed, paneCount, exactSource);
      }
    });
});
