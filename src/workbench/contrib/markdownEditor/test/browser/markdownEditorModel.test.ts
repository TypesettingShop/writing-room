import { baseKeymap, splitBlock, toggleMark } from 'prosemirror-commands';
import { undo } from 'prosemirror-history';
import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';
import type { Node } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { parseMarkdownWithSource } from '../../../../../editor/common/markdown/parser.js';
import * as markdownSerialization from '../../../../../editor/common/markdown/serializer.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { MarkdownEditorModel } from '../../browser/markdownEditorModel.js';
import { createMarkdownCaretParagraph, markdownCaretParagraphKey, markdownCaretParagraphSide } from '../../browser/markdownEditorSelection.js';

function editLine(model: TestTextModel, line: number, startColumn: number, endColumn: number, text: string): void {
  model.applyEdits([{ range: { startLineNumber: line, startColumn, endLineNumber: line, endColumn }, text }]);
}

function applyOffsets(model: TestTextModel, from: number, to: number, text: string): void {
  const start = model.getPositionAt(from);
  const end = model.getPositionAt(to);
  model.applyEdits([{
    range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
    text,
  }]);
}

function placeRuleCaret(sync: MarkdownEditorModel, index: number, side: -1 | 1): void {
  expect(sync.state.doc.child(index).type.name).toBe('horizontal_rule');
  placeAtomCaret(sync, index, side);
}

function placeAtomCaret(sync: MarkdownEditorModel, index: number, side: -1 | 1): void {
  const { state } = sync;
  const atom = state.doc.child(index);
  expect(atom.isAtom).toBe(true);
  let gap = side === 1 ? atom.nodeSize : 0;
  for (let before = 0; before < index; before++) gap += state.doc.child(before).nodeSize;
  const tr = state.tr.insert(gap, createMarkdownCaretParagraph(state.schema.nodes.paragraph, side));
  sync.dispatch(tr.setSelection(TextSelection.create(tr.doc, gap + 1))
    .setMeta(markdownCaretParagraphKey, true).setMeta('addToHistory', false));
}

describe('MarkdownEditorModel', () => {
  it('writes a styled empty paragraph at the end and keeps it when its class changes', () => {
    const model = new TestTextModel(URI.parse('file:///styled.md'), 'Alpha\n\n[]{.x}');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const pos = sync.state.doc.firstChild!.nodeSize;
      sync.dispatch(sync.state.tr.setNodeMarkup(pos, undefined, { classes: ['y'] }));
      expect(model.getValue()).toBe('Alpha\n\n[]{.y}');
      const end = sync.state.doc.content.size;
      sync.dispatch(sync.state.tr.insert(end, sync.state.schema.nodes.paragraph.create({ classes: ['z'] })));
      expect(model.getValue()).toBe('Alpha\n\n[]{.y}\n\n[]{.z}');
      sync.dispatch(sync.state.tr.insert(sync.state.doc.content.size, sync.state.schema.nodes.paragraph.create()));
      expect(model.getValue()).toBe('Alpha\n\n[]{.y}\n\n[]{.z}');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('writes a minimal model edit for a document transaction and leaves selection changes alone', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n=====\n\nLast\n');
    const changed = vi.fn();
    model.onDidChangeContent(changed);
    const show = vi.fn();
    const sync = new MarkdownEditorModel(model, [], show);
    try {
      sync.dispatch(sync.state.tr.setMeta('selection-only', true));
      expect(changed).not.toHaveBeenCalled();
      sync.dispatch(sync.state.tr.insertText('!', sync.state.doc.content.size - 1));
      expect(model.getValue()).toBe('First\n=====\n\nLast!\n');
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0].changes).toEqual([expect.objectContaining({ rangeOffset: 17, rangeLength: 0, text: '!' })]);
      expect(show).toHaveBeenCalledTimes(2);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('reflects external changes across panes once and uses their updated source spelling', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), '# First\n\nLast');
    const first = new MarkdownEditorModel(model, [], () => {});
    const second = new MarkdownEditorModel(model, [], () => {});
    try {
      model.applyEdits([{
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
        text: 'First\n=====\n',
      }]);
      first.dispatch(first.state.tr.insertText('!', first.state.doc.content.size - 1));
      expect(second.state.doc.textContent).toBe('FirstLast!');
      expect(model.getVersionId()).toBe(3);
      expect(model.getValue()).toBe('First\n=====\n\nLast!');
    } finally {
      first.dispose();
      second.dispose();
      model.dispose();
    }
  });

  it('rebases a final composition transaction flushed before an external source change', () => {
    const original = 'First\n\n안녕하세';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const flushComposition = vi.fn(() => {
      const { doc, tr } = sync.state;
      expect(doc.textContent).toBe('First안녕하세');
      sync.dispatch(tr.insertText('요', doc.content.size - 1).setMeta('composition', 1));
    });
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, flushComposition);
    const other = new MarkdownEditorModel(model, [], () => {});
    try {
      editLine(model, 1, 1, 1, 'Inserted\n\n');
      expect(flushComposition).toHaveBeenCalledTimes(1);
      expect(model.getValue()).toBe('Inserted\n\nFirst\n\n안녕하세요');
      expect(sync.state.doc.eq(other.state.doc)).toBe(true);
      expect(sync.state.doc.textContent).toBe('InsertedFirst안녕하세요');
    } finally {
      other.dispose();
      sync.dispose();
      model.dispose();
    }
  });

  it('groups adjacent typing within 500 milliseconds and isolates a formatting command', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'A');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      sync.dispatch(sync.state.tr.insertText('B', 2).setTime(1000));
      sync.dispatch(sync.state.tr.insertText('C', 3).setTime(1250));
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, 2, 4)));
      expect(sync.runFormattingCommand(toggleMark(sync.state.schema.marks.strong))).toBe(true);
      expect(model.getValue()).toBe('A**BC**');

      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('ABC');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('A');
      expect(sync.canUndo).toBe(false);

      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('ABC');
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('A**BC**');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('undoes a source-only edit as an external history step and restores the exact source', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const original = sync.state.doc;
      model.setValue('First\n\n\nLast');
      expect(sync.state.doc.eq(original)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\nLast');
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('First\n\n\nLast');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('redoes an external spelling change exactly after undoing the typing that followed it', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), '# First\n\n* a\n* b\n');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      model.setValue('First\n=====\n\n- a\n- b\n');
      sync.dispatch(sync.state.tr.insertText('!', sync.state.doc.content.size - 2).setTime(5000));
      const typed = model.getValue();
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n=====\n\n- a\n- b\n');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('# First\n\n* a\n* b\n');
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('First\n=====\n\n- a\n- b\n');
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(typed);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('shares untouched blocks across isolated paragraph edits and retains their original source for rich typing', () => {
    const original = 'First\n\n\nSecond\n\nHeading\n=======\n\n* last\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const { doc } = sync.state;
      const second = doc.child(1);
      const heading = doc.child(2);
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(doc, doc.child(0).nodeSize + 3)));

      editLine(model, 1, 6, 6, ' A');
      const firstEdit = model.getValue();
      expect(sync.state.doc.child(1)).toBe(second);
      expect(sync.state.doc.child(2)).toBe(heading);
      expect(sync.state.selection.$anchor.parent).toBe(second);
      editLine(model, 1, 8, 8, '  ');
      const spellingEdit = model.getValue();
      expect(sync.state.doc.eq(parseMarkdownWithSource(spellingEdit).doc)).toBe(true);
      expect(sync.state.doc.child(1)).toBe(second);

      sync.dispatch(sync.state.tr.insertText('!', sync.state.doc.child(0).nodeSize + second.nodeSize - 1));
      const typed = spellingEdit.replace('Second', 'Second!');
      expect(model.getValue()).toBe(typed);
      for (const source of [spellingEdit, firstEdit, original]) {
        expect(sync.undo()).toBe(true);
        expect(model.getValue()).toBe(source);
      }
      for (const source of [firstEdit, spellingEdit, typed]) {
        expect(sync.redo()).toBe(true);
        expect(model.getValue()).toBe(source);
      }
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('uses the full parser when editing a paragraph into a definition used by an earlier block', () => {
    const original = '[shortcut]\n\nPlain note';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      editLine(model, 3, 11, 11, ' added');
      const plain = model.getValue();
      const shortcut = sync.state.doc.firstChild;
      editLine(model, 3, 1, 17, '[shortcut]: ./target.md');
      const definition = model.getValue();
      expect(sync.state.doc.firstChild).not.toBe(shortcut);
      expect(sync.state.doc.firstChild?.firstChild?.marks[0]?.attrs.href).toBe('./target.md');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(plain);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.redo()).toBe(true);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(definition);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('applies shared changes in order when an earlier model listener edits during delivery', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        editLine(model, 3, 5, 5, ' outer');
      }
      if (event.versionId === 4) {
        editLine(model, 1, 14, 14, ' nested');
      }
    });
    const collect = (seen: string[]) => (state: EditorState) => seen.push(state.doc.textBetween(0, state.doc.content.size, '\n'));
    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    const first = new MarkdownEditorModel(model, [], collect(firstSeen));
    const second = new MarkdownEditorModel(model, [], collect(secondSeen));
    try {
      editLine(model, 1, 6, 6, ' source');
      expect(firstSeen).toEqual(['First source\nLast', 'First source\nLast outer']);
      expect(secondSeen).toEqual(firstSeen);

      first.dispatch(first.state.tr.insertText('!', first.state.doc.child(0).nodeSize - 1));
      expect(secondSeen.slice(2)).toEqual(['First source!\nLast outer', 'First source! nested\nLast outer']);
      expect(model.getValue()).toBe('First source! nested\n\nLast outer');
      expect(first.undo()).toBe(true);
      expect(model.getValue()).toBe('First source!\n\nLast outer');
      expect(first.undo()).toBe(true);
      expect(model.getValue()).toBe('First source\n\nLast outer');
    } finally {
      first.dispose();
      second.dispose();
      model.dispose();
    }
  });

  it('keeps the pending source change and rich edit as separate exact undo and redo steps', () => {
    const original = 'First\n\nMiddle\n\nLast';
    const external = original + ' ext';
    const typed = 'X' + external;
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    let sync: MarkdownEditorModel | undefined;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        sync!.dispatch(sync!.state.tr.insertText('X', 1));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      editLine(model, 5, 5, 5, ' ext');
      const expectSource = (source: string) => {
        expect(model.getValue()).toBe(source);
        expect(sync!.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
      };
      expectSource(typed);
      for (const source of [external, original]) {
        expect(sync.undo()).toBe(true);
        expectSource(source);
      }
      expect(sync.canUndo).toBe(false);
      for (const source of [external, typed]) {
        expect(sync.redo()).toBe(true);
        expectSource(source);
      }
      expect(sync.canRedo).toBe(false);
      // A later source edit still reads from the text the queued write left.
      editLine(model, 3, 7, 7, ' more');
      expectSource(typed.replace('Middle', 'Middle more'));
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('pairs the rich state with its write when a later change arrives before the write event', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    let sync: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        sync.dispatch(sync.state.tr.insertText('X', 1));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    // A listener after the pane edits the model while the pane's queued write is being delivered.
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        editLine(model, 3, 1, 1, 'T');
      }
    });
    try {
      const expectSource = (source: string) => {
        expect(model.getValue()).toBe(source);
        expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
      };
      editLine(model, 3, 5, 5, ' ext');
      expectSource('XFirst\n\nTLast ext');
      for (const source of ['XFirst\n\nLast ext', 'First\n\nLast ext', 'First\n\nLast']) {
        expect(sync.undo()).toBe(true);
        expectSource(source);
      }
      expect(sync.canUndo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('applies the rest of the queue when a queued edit fails or its pane closes', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    let first: MarkdownEditorModel;
    let second: MarkdownEditorModel;
    second = new MarkdownEditorModel(model, [], () => {});
    // The second pane has read the change; the first, which has not, queues ahead of it and closes.
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        first.dispatch(first.state.tr.insertText('A', 1));
        second.runFormattingCommand(() => {
          throw new Error('failed command');
        });
        second.dispatch(second.state.tr.insertText('B', 1));
        first.dispose();
      }
    });
    first = new MarkdownEditorModel(model, [], () => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      editLine(model, 3, 5, 5, ' ext');
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed command' }));
      expect(model.getValue()).toBe('BFirst\n\nLast ext');
      second.dispatch(second.state.tr.insertText('C', 1));
      expect(model.getValue()).toBe('CBFirst\n\nLast ext');
    } finally {
      error.mockRestore();
      second.dispose();
      model.dispose();
    }
  });

  it.each([
    { last: 'Bravo\n\n_Charlie_', appended: 'Delta', target: 1, expected: 'BravoX\n\n_Charlie_\n\nDelta' },
    { last: 'Alpha', appended: 'Alpha', target: 1, expected: 'AlphaX\n\nAlpha' },
    { last: 'Alpha', appended: 'Alpha', target: 0, expected: 'Alpha\n\nAlpha' },
  ])('tracks the queued edit from paragraph $target when deleting Alpha and appending $appended', ({ last, appended, target, expected }) => {
    const original = 'Alpha\n\n' + last;
    const external = last + '\n\n' + appended;
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    let sync: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        const doc = sync.state.doc;
        const end = doc.child(target).nodeSize - 1 + (target === 0 ? 0 : doc.firstChild!.nodeSize);
        sync.dispatch(sync.state.tr.insertText('X', end));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const { lineNumber, column } = model.getPositionAt(original.length);
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '' },
        { range: { startLineNumber: lineNumber, startColumn: column, endLineNumber: lineNumber, endColumn: column },
          text: '\n\n' + appended },
      ]);
      const expectSource = (source: string) => {
        expect(model.getValue()).toBe(source);
        expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
      };
      expectSource(expected);
      const written = [original, external, expected].filter((source, index, versions) => source !== versions[index - 1]);
      for (const source of written.slice(0, -1).reverse()) {
        expect(sync.undo()).toBe(true);
        expectSource(source);
      }
      expect(sync.canUndo).toBe(false);
      for (const source of written.slice(1)) {
        expect(sync.redo()).toBe(true);
        expectSource(source);
      }
      expect(sync.canRedo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { event: 'exact', removeFirst: true, target: 0, expected: 'Bravo' },
    { event: 'exact', removeFirst: true, target: 2, expected: 'BravoX' },
    { event: 'exact', removeFirst: false, target: 0, expected: 'BravoX' },
    { event: 'exact', removeFirst: false, target: 2, expected: 'Bravo' },
    { event: 'reload', removeFirst: true, target: 0, expected: 'Bravo' },
    { event: 'reload', removeFirst: true, target: 2, expected: 'Bravo' },
    { event: 'skipped', removeFirst: true, target: 0, expected: 'Bravo\n\nEnd' },
    { event: 'skipped', removeFirst: true, target: 2, expected: 'Bravo\n\nEnd' },
  ] as const)('tracks the duplicate paragraph $target through $event (remove first: $removeFirst)',
    ({ event, removeFirst, target, expected }) => {
      const original = 'Bravo\n\nAlpha\n\nBravo';
      const external = event === 'skipped' ? 'Bravo\n\nEnd' : 'Bravo';
      const model = new TestTextModel(URI.parse('file:///draft.md'), original);
      const removeRange = () => applyOffsets(model, removeFirst ? 0 : 5, removeFirst ? 14 : 19, '');
      let sync: MarkdownEditorModel;
      const earlier = model.onDidChangeContent(change => {
        if (change.versionId !== 2) return;
        const { doc, tr } = sync.state;
        const end = target === 0 ? doc.firstChild!.nodeSize - 1 : doc.content.size - 1;
        sync.dispatch(tr.insertText('X', end));
        if (event === 'skipped') removeRange();
      });
      sync = new MarkdownEditorModel(model, [], () => {});
      const later = model.onDidChangeContent(change => {
        if (change.versionId === 2 && event === 'skipped') editLine(model, 1, 6, 6, '\n\nEnd');
      });
      try {
        if (event === 'exact') removeRange();
        else model.setValue(event === 'skipped' ? original : external);

        const expectSource = (source: string) => {
          expect(model.getValue()).toBe(source);
          expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
        };
        expectSource(expected);
        if (expected !== external) {
          expect(sync.undo()).toBe(true);
          expectSource(external);
        }
        expect(sync.undo()).toBe(true);
        expectSource(original);
        expect(sync.canUndo).toBe(false);
        expect(sync.redo()).toBe(true);
        expectSource(external);
        if (expected !== external) {
          expect(sync.redo()).toBe(true);
          expectSource(expected);
        }
        expect(sync.canRedo).toBe(false);
      } finally {
        later.dispose();
        earlier.dispose();
        sync.dispose();
        model.dispose();
      }
    },
  );

  it.each([
    { start: 8, end: 11, text: 'IAN', expected: 'Same\n\nAlIANBravoX\n\nSame' },
    { start: 6, end: 16, text: 'Replaced', expected: 'Same\n\nReplacedX\n\nSame' },
    { start: 11, end: 11, text: '\n\n', expected: 'Same\n\nAlpha\n\nBravoX\n\nSame' },
  ])('rebases a pending edit after a single paragraph change at $start ($text)', ({ start, end, text, expected }) => {
    const original = 'Same\n\nAlphaBravo\n\nSame';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const listener = model.onDidChangeContent(change => {
      if (change.versionId !== 2) return;
      const { doc, tr } = sync.state;
      sync.dispatch(tr.insertText('X', doc.firstChild!.nodeSize + doc.child(1).nodeSize - 1));
    });
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      applyOffsets(model, start, end, text);
      expect(model.getValue()).toBe(expected);
      expect(sync.state.doc.eq(parseMarkdownWithSource(expected).doc)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original.slice(0, start) + text + original.slice(end));
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
    } finally {
      listener.dispose();
      sync.dispose();
      model.dispose();
    }
  });

  describe.each([
    { container: 'list', prefix: '', row: (text: string) => '- ' + text, separator: '\n' },
    { container: 'nested list', prefix: '- Parent\n', row: (text: string) => '    - ' + text, separator: '\n' },
    { container: 'quote', prefix: '', row: (text: string) => '> ' + text, separator: '\n>\n' },
    { container: 'table', prefix: '| Title |\n| --- |\n', row: (text: string) => '| ' + text + ' |', separator: '\n' },
  ])('pending composition inside a $container', ({ container, prefix, row, separator }) => {
    const bravo = row('Bravo');
    const alpha = row('Alpha');
    const composed = row('Bravo요');
    const original = prefix + [bravo, alpha, bravo].join(separator);
    const secondRow = prefix.length + bravo.length + separator.length;
    const lastRow = secondRow + alpha.length + separator.length;
    const repeated = prefix + [bravo, bravo, bravo].join(separator);
    const firstText = prefix.length + bravo.indexOf('Bravo');
    const middleText = secondRow + alpha.indexOf('Alpha');
    const lastText = lastRow + bravo.indexOf('Bravo');
    const uniqueContainer = prefix + [alpha, bravo].join(separator);

    function textEnd(doc: Node, text: string, occurrence = 0): number {
      const positions: number[] = [];
      doc.descendants((node, pos) => {
        if (node.isText && node.text === text) positions.push(pos + node.nodeSize);
      });
      return positions[occurrence];
    }

    it.each<{
      label: string;
      target: number;
      survivor?: number;
      targetText?: string;
      survivingText?: string;
      external: string;
      typed?: string;
      initialSource?: string;
      edits?: [from: number, to: number, text: string][];
    }>([
      { label: 'deletes the target at the start', target: 0, external: prefix + bravo,
        edits: [[prefix.length, lastRow, '']] },
      { label: 'deletes the prefix before the target', target: 1, survivor: 0, external: prefix + bravo, typed: prefix + composed,
        edits: [[prefix.length, lastRow, '']] },
      { label: 'deletes the suffix after the target', target: 0, survivor: 0, external: prefix + bravo, typed: prefix + composed,
        edits: [[secondRow - separator.length, original.length, '']] },
      { label: 'moves the target in a batch', target: 0, external: prefix + [alpha, bravo, bravo].join(separator),
        edits: [[prefix.length, secondRow, ''], [original.length, original.length, separator + bravo]] },
      { label: 'moves another row in a batch', target: 1, survivor: 0, external: prefix + [alpha, bravo, bravo].join(separator),
        typed: prefix + [alpha, composed, bravo].join(separator),
        edits: [[prefix.length, secondRow, ''], [original.length, original.length, separator + bravo]] },
      { label: 'rewrites the target with the same source', target: 0, external: original,
        edits: [[prefix.length, prefix.length + bravo.length, bravo]] },
      { label: 'rewrites another row with the same source', target: 1, survivor: 1, external: original,
        typed: prefix + [bravo, alpha, composed].join(separator), edits: [[prefix.length, prefix.length + bravo.length, bravo]] },
      { label: 'moves a surviving copy while the source stays identical', target: 1, survivor: 0, initialSource: repeated,
        external: repeated, typed: prefix + [composed, bravo, bravo].join(separator),
        edits: [[prefix.length, secondRow, ''], [repeated.length, repeated.length, separator + bravo]] },
      { label: 'reloads reordered text without ranges', target: 0, external: prefix + [alpha, bravo, bravo].join(separator) },
      { label: 'keeps the next target when a deletion joins two entry boundaries', target: 0, targetText: 'Alpha', survivor: 0,
        external: prefix + [alpha, bravo].join(separator), typed: prefix + [row('Alpha요'), bravo].join(separator),
        edits: [[firstText, middleText, '']] },
      { label: 'does not confuse the remaining marker with the replaced target', target: 1,
        external: prefix + [bravo, alpha, row('Zulu')].join(separator), edits: [[lastText, lastText + 'Bravo'.length, 'Zulu']] },
      { label: 'keeps an unchanged unique container through a reload without ranges', target: 0, survivor: 0,
        initialSource: 'Before\n\n' + uniqueContainer, external: 'After\n\n' + uniqueContainer,
        typed: 'After\n\n' + prefix + [alpha, composed].join(separator) },
      {
        label: 'keeps the target text block during a partial edit in the same entry', target: 0, survivor: 0,
        targetText: 'Alpha', survivingText: 'ALpha',
        external: prefix + [bravo, row('ALpha'), bravo].join(separator),
        typed: prefix + [bravo, row('ALpha요'), bravo].join(separator),
        edits: [[middleText + 1, middleText + 2, 'L']],
      },
      ...(container === 'table' ? [{
        label: 'keeps an intact cell containing only punctuation', target: 0, survivor: 0, targetText: '>',
        initialSource: prefix + [bravo, row('>')].join(separator), external: prefix + row('>'), typed: prefix + row('>요'),
        edits: [[prefix.length, secondRow, ''] satisfies [number, number, string]],
      }] : []),
      ...(container === 'list' ? [{
        label: 'keeps the composition when only the task marker changes', target: 0, survivor: 0, targetText: 'Alpha',
        initialSource: '- [ ] Alpha', external: '- [x] Alpha', typed: '- [x] Alpha요', edits: [[3, 4, 'x'] satisfies [number, number, string]],
      }, {
        label: 'keeps the composition when only the ordered marker changes', target: 0, survivor: 0, targetText: 'Alpha',
        initialSource: '2. Alpha', external: '5. Alpha', typed: '5. Alpha요', edits: [[0, 1, '5'] satisfies [number, number, string]],
      }] : []),
    ])('$label', ({ target, survivor, targetText = 'Bravo', survivingText = targetText, external, typed, initialSource = original, edits }) => {
      const model = new TestTextModel(URI.parse('file:///draft.md'), initialSource);
      const listener = model.onDidChangeContent(event => {
        if (event.versionId === 2) sync.dispatch(sync.state.tr.insertText('요').setMeta('composition', 1));
      });
      const sync = new MarkdownEditorModel(model, [], () => {});
      try {
        const initial = textEnd(sync.state.doc, targetText, target);
        sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, initial)));

        if (edits) {
          model.applyEdits(edits.map(([from, to, text]) => {
            const start = model.getPositionAt(from);
            const end = model.getPositionAt(to);
            return {
              range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column },
              text,
            };
          }));
        } else {
          model.setValue(external);
        }

        const expectState = (source: string) => {
          expect(model.getValue()).toBe(source);
          expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
          expect(sync.state.selection.empty).toBe(true);
          expect(sync.state.selection.$head.parent.inlineContent).toBe(true);
        };
        expectState(typed ?? external);
        if (typed) {
          expect(sync.state.selection.head).toBe(textEnd(sync.state.doc, survivingText + '요'));
          expect(sync.undo()).toBe(true);
          expectState(external);
          expect(sync.state.selection.head).toBe(textEnd(sync.state.doc, survivingText, survivor));
        }
        if (external !== initialSource) {
          expect(sync.undo()).toBe(true);
          expectState(initialSource);
          expect(sync.state.selection.head).toBe(initial);
        }
        expect(sync.canUndo).toBe(false);
        if (external !== initialSource) {
          expect(sync.redo()).toBe(true);
          expectState(external);
          expect(sync.state.selection.head).toBe(Selection.atEnd(sync.state.doc).head);
        }
        if (typed) {
          expect(sync.redo()).toBe(true);
          expectState(typed);
          expect(sync.state.selection.head).toBe(textEnd(sync.state.doc, survivingText + '요'));
        }
        expect(sync.canRedo).toBe(false);
      } finally {
        listener.dispose();
        sync.dispose();
        model.dispose();
      }
    });
  });

  it.each([
    { original: '| Alpha | Bravo |', from: 'Bravo', to: 'Zulu', target: 0, typed: '| Alpha요 | Zulu |' },
    { original: '| Bravo | Bravo |', from: 'Bravo', to: 'Zulu', target: 1, typed: '| Zulu | Bravo요 |' },
    { original: 'A\\|B | Bravo', from: 'Bravo', to: 'Zulu', target: 0, typed: '| A\\|B요 | Zulu |' },
    { original: '| | Alpha |', from: ' Alpha |', to: ' Zulu |', target: 0, typed: '| 요 | Zulu |' },
    { original: '| Alpha | Bravo |', from: 'Alpha', to: 'Zulu', target: 0 },
    { original: '| Alpha | Bravo |', from: 'Alpha | Bravo', to: 'Bravo | Alpha', target: 0 },
    { original: '| Alpha | Bravo |', from: 'ph', to: '|', target: 0 },
  ])('keeps a queued composition only in a proven table cell ($original, $from → $to, cell $target)',
    ({ original, from, to, target, typed }) => {
      const header = '| A | B |\n| --- | --- |\n';
      const source = header + original;
      const external = header + original.replace(from, to);
      const model = new TestTextModel(URI.parse('file:///table.md'), source);
      const listener = model.onDidChangeContent(event => {
        if (event.versionId === 2) sync.dispatch(sync.state.tr.insertText('요').setMeta('composition', 1));
      });
      const sync = new MarkdownEditorModel(model, [], () => {});
      const tablePosition = () => {
        const table = sync.state.doc.firstChild!;
        const row = table.child(1);
        let end = 3 + table.firstChild!.nodeSize;
        for (let column = 0; column < target; column++) end += row.child(column).nodeSize;
        return end + row.child(target).content.size;
      };
      const expectSource = (text: string) => {
        expect(model.getValue()).toBe(text);
        expect(sync.state.doc.eq(parseMarkdownWithSource(text).doc)).toBe(true);
      };
      try {
        const initial = tablePosition();
        sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, initial)));
        const start = header.length + original.indexOf(from);
        applyOffsets(model, start, start + from.length, to);
        expectSource(typed ? header + typed : external);
        if (typed) {
          expect(sync.state.selection.head).toBe(tablePosition());
          expect(sync.undo()).toBe(true);
          expectSource(external);
          expect(sync.state.selection.head).toBe(tablePosition());
        }
        expect(sync.undo()).toBe(true);
        expectSource(source);
        expect(sync.state.selection.head).toBe(initial);
        expect(sync.canUndo).toBe(false);
        expect(sync.redo()).toBe(true);
        expectSource(external);
        if (typed) {
          expect(sync.redo()).toBe(true);
          expectSource(header + typed);
          expect(sync.state.selection.head).toBe(tablePosition());
        }
        expect(sync.canRedo).toBe(false);
      } finally {
        listener.dispose();
        sync.dispose();
        model.dispose();
      }
    });

  it('moves the selected image with its surviving list item when the source stays identical', () => {
    const item = '- ![map](map.png)';
    const original = [item, item, item].join('\n');
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const listener = model.onDidChangeContent(event => {
      if (event.versionId === 2) sync.dispatch(sync.state.tr.setMeta('test', true));
    });
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const images: number[] = [];
      sync.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') images.push(pos);
      });
      sync.dispatch(sync.state.tr.setSelection(NodeSelection.create(sync.state.doc, images[1])));
      const end = model.getPositionAt(original.length);
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 }, text: '' },
        { range: { startLineNumber: end.lineNumber, startColumn: end.column, endLineNumber: end.lineNumber, endColumn: end.column },
          text: '\n' + item },
      ]);
      expect(sync.state.selection).toBeInstanceOf(NodeSelection);
      expect(sync.state.selection.from).toBe(images[0]);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
    } finally {
      listener.dispose();
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { label: 'splits a paragraph', original: 'AlphaBravo\n\nCharlie\n\nDelta', external: 'Alpha\n\nBravo\n\nDelta',
      changes: [[5, 5, '\n\n'], [12, 21, '']], from: 5, to: 5 },
    { label: 'joins two paragraphs', original: 'Alpha\n\nBravo\n\nCharlie', external: 'Alpha Bravo\n\nAdded\n\nCharlie',
      changes: [[5, 7, ' '], [14, 14, 'Added\n\n']], from: 2, to: 2 },
    { label: 'deletes part of the selection', original: 'Alpha\n\nBravo', external: 'Bravo\n\nCharlie',
      changes: [[0, 7, ''], [12, 12, '\n\nCharlie']], from: 3, to: 10 },
    { label: 'inserts another paragraph inside the selection', original: 'Alpha\n\nBravo\n\nCharlie',
      external: 'Alpha\n\nNew\n\nBravo', changes: [[5, 5, '\n\nNew'], [12, 21, '']], from: 3, to: 10 },
    { label: 'replaces a list item with identical source', original: '- Alpha\n- Alpha', external: '- Alpha\n- Alpha',
      changes: [[0, 8, ''], [15, 15, '\n- Alpha']], from: 8, to: 8 },
    { label: 'keeps only the line ending of a paragraph', original: 'Alpha\n\nBravo', external: 'Zed\n\nBravo',
      changes: [[0, 4, ''], [4, 5, 'Zed']], from: 6, to: 6 },
  ] as const)('drops a queued replacement when the source batch $label', ({ original, external, changes, from, to }) => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const listener = model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        sync.dispatch(sync.state.tr.insertText('X', from, to));
      }
    });
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      model.applyEdits(changes.map(([start, end, text]) => {
        const { lineNumber: startLineNumber, column: startColumn } = model.getPositionAt(start);
        const { lineNumber: endLineNumber, column: endColumn } = model.getPositionAt(end);
        return { range: { startLineNumber, startColumn, endLineNumber, endColumn }, text };
      }));
      expect(model.getValue()).toBe(external);
      expect(sync.state.doc.eq(parseMarkdownWithSource(external).doc)).toBe(true);
      if (external !== original) {
        expect(sync.undo()).toBe(true);
        expect(model.getValue()).toBe(original);
      }
      expect(sync.canUndo).toBe(false);
    } finally {
      listener.dispose();
      sync.dispose();
      model.dispose();
    }
  });

  it('replays queued steps and selection over several source versions on two panes', () => {
    const original = '# First\n\nMiddle\n\nLast\n';
    const spelling = original.replace('# First', 'First\n=====');
    const prefix = 'Before\n\n';
    const extended = prefix + spelling;
    const external = extended.replace('Last', 'Last ext');
    const typed = external.replace('Middle', 'ABMiddle');
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    let first: MarkdownEditorModel;
    let second: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        const middle = first.state.doc.firstChild!.nodeSize + 1;
        const tr = first.state.tr.insertText('A', middle).insertText('B', middle + 1);
        first.dispatch(tr.setSelection(TextSelection.create(tr.doc, middle, middle + 2)));
        editLine(model, 1, 1, 1, prefix);
      }
      if (event.versionId === 3) {
        editLine(model, 8, 5, 5, ' ext');
      }
    });
    first = new MarkdownEditorModel(model, [], () => {});
    second = new MarkdownEditorModel(model, [], () => {});
    try {
      const expectSource = (source: string) => {
        const parsed = parseMarkdownWithSource(source).doc;
        expect(model.getValue()).toBe(source);
        expect(first.state.doc.eq(parsed)).toBe(true);
        expect(second.state.doc.eq(parsed)).toBe(true);
      };
      model.setValue(spelling);
      expectSource(typed);
      expect(first.state.selection.$from.parent.textContent).toBe('ABMiddle');
      expect(first.state.selection.$from.parentOffset).toBe(0);
      expect(first.state.selection.$to.parentOffset).toBe(2);
      for (const source of [external, extended, spelling, original]) {
        expect(first.undo()).toBe(true);
        expectSource(source);
      }
      expect(first.canUndo).toBe(false);
      for (const source of [spelling, extended, external, typed]) {
        expect(first.redo()).toBe(true);
        expectSource(source);
      }
      expect(first.canRedo).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
      model.dispose();
    }
  });

  it('runs a native history command against the caught-up state', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    let sync: MarkdownEditorModel;
    const nativeUndo = vi.fn();
    model.onDidChangeContent(event => {
      if (event.versionId === 3) {
        nativeUndo(undo(sync.state, transaction => sync.dispatch(transaction)));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      sync.dispatch(sync.state.tr.insertText('X', 1));
      editLine(model, 3, 5, 5, ' ext');
      expect(nativeUndo).toHaveBeenCalledWith(true);
      expect(model.getValue()).toBe('XFirst\n\nLast');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\nLast');
      expect(sync.redo()).toBe(true);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('XFirst\n\nLast ext');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('replays rich requests from two panes in request order', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nLast');
    let first: MarkdownEditorModel;
    let second: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        second.dispatch(second.state.tr.insertText('A', 1));
        first.dispatch(first.state.tr.insertText('B', 1));
        first.dispatch(first.state.tr.insertText('C', 1));
      }
    });
    first = new MarkdownEditorModel(model, [], () => {});
    second = new MarkdownEditorModel(model, [], () => {});
    try {
      const expectSource = (source: string) => {
        const parsed = parseMarkdownWithSource(source).doc;
        expect(model.getValue()).toBe(source);
        expect(first.state.doc.eq(parsed)).toBe(true);
        expect(second.state.doc.eq(parsed)).toBe(true);
      };
      editLine(model, 3, 5, 5, ' ext');
      expectSource('ABCFirst\n\nLast ext');
      expect(first.undo()).toBe(true);
      expectSource('AFirst\n\nLast ext');
      expect(first.undo()).toBe(true);
      expectSource('First\n\nLast ext');
      expect(first.undo()).toBe(true);
      expectSource('First\n\nLast');
      expect(first.canUndo).toBe(false);
    } finally {
      first.dispose();
      second.dispose();
      model.dispose();
    }
  });

  it('maps a queued rich edit in the unchanged block between batched source edits', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nMiddle\n\nLast');
    let sync: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        sync.dispatch(sync.state.tr.insertText('X', sync.state.doc.firstChild!.nodeSize + 1));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: 'New ' },
        { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 1 }, text: 'New ' },
      ]);
      expect(model.getValue()).toBe('New First\n\nXMiddle\n\nNew Last');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('New First\n\nMiddle\n\nNew Last');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\nMiddle\n\nLast');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('reads the live text when a later source version arrives before an earlier one', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nMiddle\n\nLast');
    // Two listeners change the model on the same version: the later one's change (v4) is delivered
    // while the earlier one's (v3) is still waiting, and its changes start from v3.
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        editLine(model, 3, 4, 4, 'Z ');
      }
    });
    const sync = new MarkdownEditorModel(model, [], () => {});
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        editLine(model, 3, 4, 4, 'q');
      }
    });
    try {
      editLine(model, 5, 5, 5, ' ext');
      expect(model.getValue()).toBe('First\n\nMidqZ dle\n\nLast ext');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\nMiddle\n\nLast ext');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('leaves the source change as the only step when a queued transaction loses its target', () => {
    const original = 'First\n\nMiddle\n\nLast';
    const external = 'First\n\nLast';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    let sync: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        const { doc, tr } = sync.state;
        sync.dispatch(tr.insertText('!', doc.content.size - 1).insertText('X', doc.firstChild!.nodeSize + 2));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      model.setValue(external);
      expect(model.getValue()).toBe(external);
      expect(sync.state.doc.eq(parseMarkdownWithSource(external).doc)).toBe(true);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(external);
      expect(sync.canRedo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps the input rule undo at its rebased position', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nMiddle-\n\nLast');
    const rules = inputRules({ rules: [new InputRule(/--$/, '—')] });
    let view: EditorView;
    const handled = vi.fn();
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        const position = view.state.doc.firstChild!.nodeSize + 'Middle-'.length + 1;
        handled(rules.props.handleTextInput?.call(rules, view, position, position, '-', () => view.state.tr));
      }
    });
    const sync = new MarkdownEditorModel(model, [rules], state => view.updateState(state));
    view = new EditorView(null, { state: sync.state, dispatchTransaction: tr => sync.dispatch(tr) });
    try {
      editLine(model, 1, 1, 1, 'Before\n\n');
      expect(handled).toHaveBeenCalledWith(true);
      expect(model.getValue()).toBe('Before\n\nFirst\n\nMiddle—\n\nLast');
      expect(undoInputRule(sync.state, tr => sync.dispatch(tr))).toBe(true);
      expect(model.getValue()).toBe('Before\n\nFirst\n\nMiddle--\n\nLast');
    } finally {
      view.destroy();
      sync.dispose();
      model.dispose();
    }
  });

  it('parses the whole file again when the written text differs from the restored source', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nMiddle\n\nLast');
    // A writer that changes what it is given, as Monaco does when it trims auto-indentation.
    const sync = new MarkdownEditorModel(model, [], () => {},
      edit => model.applyEdits([{ ...edit, text: (edit.text ?? '') + '!' }]));
    try {
      editLine(model, 5, 5, 5, ' ext');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\nMiddle\n\nLast!');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
      editLine(model, 3, 7, 7, ' more');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps untouched blocks while typing prose punctuation in a paragraph', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), '첫 문단\n\n가격은 50% 할인/정가… “인용”·끝\n\n# 제목\n');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const heading = sync.state.doc.child(2);
      editLine(model, 3, 4, 4, ' 오늘');
      expect(sync.state.doc.child(2)).toBe(heading);
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { name: 'blank lines', gap: '\n\n\n', first: 'a', middle: 'b', last: 'c' },
    { name: 'a whitespace-only line and repeated paragraphs', gap: '\n\n \t\n', first: 'same', middle: 'same', last: 'same' },
  ])('preserves $name before a paragraph split after an incremental source edit', ({ gap, first, middle, last }) => {
    const original = `${first}${gap}${middle}\n\n\n${last}\n`;
    const external = `${first}a${gap}${middle}\n\n\n${last}\n`;
    const written = `${first}a${gap}${middle}\n\nx\n\n${last}\n`;
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const middleBeforeEdit = sync.state.doc.child(1);
      editLine(model, 1, first.length + 1, first.length + 1, 'a');
      expect(sync.state.doc.child(1)).toBe(middleBeforeEdit);
      const { doc } = sync.state;
      const end = doc.child(0).nodeSize + doc.child(1).nodeSize - 1;
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(doc, end)));
      expect(splitBlock(sync.state, tr => sync.dispatch(tr.setTime(1000)))).toBe(true);
      expect(model.getValue()).toBe(external);
      sync.dispatch(sync.state.tr.insertText('x').setTime(1100));
      expect(model.getValue()).toBe(written);

      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(external);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(external);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(written);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { where: 'after the final rule', original: 'First\n\n---\n', side: 1, written: 'First!\n\n---\n\nAdded\n' },
    { where: 'before a middle rule', original: 'First\n\n---\n\nLast\n', side: -1, written: 'First!\n\nAdded\n\n---\n\nLast\n' },
  ] as const)('writes $where after an external paragraph edit and replays both history events', ({ original, side, written }) => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, side);
      expect(model.getVersionId()).toBe(1);
      expect(sync.canUndo).toBe(false);
      editLine(model, 1, 6, 6, '!');
      const externallyEdited = original.replace('First', 'First!');
      expect(sync.state.selection.$head.parent.textContent).toBe('');
      expect(model.getVersionId()).toBe(2);
      sync.dispatch(sync.state.tr.insertText('Added'));
      expect(model.getValue()).toBe(written);
      expect(model.getVersionId()).toBe(3);

      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(externallyEdited);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(externallyEdited);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe(written);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('moves to surviving text when the targeted rule is deleted, even with another identical rule', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast\n\n---\n');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 3, 1);
      model.applyEdits([{ range: { startLineNumber: 7, startColumn: 1, endLineNumber: 8, endColumn: 1 }, text: '' }]);
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
      expect(sync.state.selection.$head.parent.textContent).toBe('Last');
      sync.dispatch(sync.state.tr.insertText('!'));
      expect(model.getValue()).toBe('First\n\n---\n\nLast!\n\n');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { original: 'Before\n\n---\n\nRemoved\n\nTail', external: 'Before\n\nReplacement', index: 1, side: -1,
      from: 8, to: 26, text: 'Replacement', expected: 'Before!\n\nReplacement' },
    { original: 'Before\n\n---\n\nAfter\n\nTail', external: 'Before\n\nReplacement\n\nAfter\n\nTail', index: 1, side: 1,
      from: 8, to: 11, text: 'Replacement', expected: 'Before\n\nReplacement\n\n!After\n\nTail' },
    { original: '[ref]: /path\n\nAfter', external: 'Replacement\n\nAfter', index: 0, side: -1,
      from: 0, to: 12, text: 'Replacement', expected: 'Replacement\n\n!After' },
    { original: 'Before\n\n---', external: 'Before\n\nReplacement', index: 1, side: 1,
      from: 8, to: 11, text: 'Replacement', expected: 'Before!\n\nReplacement' },
    { original: 'Repeat\n\n---\n\nRepeat\n\nTail', external: 'Repeat\n\nReplacement\n\nRepeat\n\nTail', index: 1, side: 1,
      from: 8, to: 11, text: 'Replacement', expected: 'Repeat\n\nReplacement\n\n!Repeat\n\nTail' },
    { original: 'Before\n\n---\n\nAfter', external: 'Before\n\nReplacement\n\nAfter', index: 1, side: -1,
      expected: 'Before!\n\nReplacement\n\nAfter' },
    { original: 'Before\n\n---\n\nAfter', external: 'Replacement', index: 1, side: 1,
      expected: '!Replacement' },
    { original: 'Before\n\n---', external: 'Replacement', index: 1, side: 1,
      expected: 'Replacement!' },
  ] as const)('moves a deleted gutter caret toward surviving text ($original → $external, $side)',
    ({ original, external, index, side, expected, ...edit }) => {
      const model = new TestTextModel(URI.parse('file:///draft.md'), original);
      const sync = new MarkdownEditorModel(model, [], () => {});
      try {
        placeAtomCaret(sync, index, side);
        if (edit.from !== undefined) {
          applyOffsets(model, edit.from, edit.to, edit.text);
        } else {
          model.setValue(external);
        }
        expect(model.getValue()).toBe(external);
        expect(sync.state.selection).toBeInstanceOf(TextSelection);
        expect(sync.state.selection.empty).toBe(true);
        expect(sync.state.doc.eq(parseMarkdownWithSource(external).doc)).toBe(true);
        expect(model.getVersionId()).toBe(2);
        sync.dispatch(sync.state.tr.insertText('!'));
        expect(model.getValue()).toBe(expected);
        expect(sync.undo()).toBe(true);
        expect(model.getValue()).toBe(external);
        expect(sync.undo()).toBe(true);
        expect(model.getValue()).toBe(original);
        expect(sync.canUndo).toBe(false);
      } finally {
        sync.dispose();
        model.dispose();
      }
    },
  );

  it('rebases input from a temporary caret flushed during an external source change', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---');
    let sync: MarkdownEditorModel;
    sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      sync.dispatch(sync.state.tr.insertText('Added').setMeta('composition', 1));
    });
    try {
      placeRuleCaret(sync, 1, 1);
      editLine(model, 1, 1, 1, 'Changed ');
      expect(model.getValue()).toBe('Changed First\n\n---\n\nAdded');
      expect(sync.state.selection.$head.parent.textContent).toBe('Added');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('Changed First\n\n---');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('preserves a final caret when the source is fully reloaded and undo removes only the reload', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast\n\n---');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 3, 1);
      model.setValue('Changed\n\n---\n\nLast\n\n---');
      expect(sync.state.selection.$head.parent).toBe(sync.state.doc.lastChild);
      expect(sync.state.doc.lastChild?.type.name).toBe('paragraph');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe('First\n\n---\n\nLast\n\n---');
      expect(sync.state.doc.lastChild?.type.name).toBe('horizontal_rule');
      expect(sync.canUndo).toBe(false);
      expect(sync.redo()).toBe(true);
      expect(model.getValue()).toBe('Changed\n\n---\n\nLast\n\n---');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([true, false])('keeps a queued composition through a source batch (rule survives: %s)', keepRule => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      sync.dispatch(sync.state.tr.insertText('Added').setMeta('composition', 1));
    });
    try {
      placeRuleCaret(sync, 1, 1);
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'Altered' },
        { range: { startLineNumber: keepRule ? 5 : 3, startColumn: 1, endLineNumber: 5, endColumn: 5 }, text: 'Replaced' },
      ]);
      const external = keepRule ? 'Altered\n\n---\n\nReplaced' : 'Altered\n\nReplaced';
      const expected = keepRule ? 'Altered\n\n---\n\nAdded\n\nReplaced' : 'Added\n\nAltered\n\nReplaced';
      const expectSource = (source: string) => {
        expect(model.getValue()).toBe(source);
        expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
      };
      expectSource(expected);
      expect(sync.state.selection.$head.parent.textContent).toBe('Added');
      expect(sync.undo()).toBe(true);
      expectSource(external);
      expect(sync.undo()).toBe(true);
      expectSource('First\n\n---\n\nLast');
      expect(sync.canUndo).toBe(false);
      expect(sync.redo()).toBe(true);
      expectSource(external);
      expect(sync.redo()).toBe(true);
      expectSource(expected);
      expect(sync.canRedo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each(['single edit', 'skipped version', 'cancelled', 'ordinary typing', 'cross-block'] as const)(
    'handles pending input at a deleted link definition (%s)', kind => {
      const original = 'First\n\n[ref]: /path\n\nLast';
      const external = kind === 'skipped version' ? 'New First\n\nLast' : 'First\n\nLast';
      const recovers = kind === 'single edit' || kind === 'skipped version';
      const model = new TestTextModel(URI.parse('file:///draft.md'), original);
      let sync: MarkdownEditorModel;
      const first = model.onDidChangeContent(event => {
        if (event.versionId === 2 && kind === 'skipped version') editLine(model, 1, 1, 1, 'New ');
      });
      const enqueue = () => {
        const { state } = sync;
        if (state.doc.childCount !== 4) return;
        const { head } = state.selection;
        const tr = state.tr.insertText('요');
        if (kind === 'cancelled') tr.delete(head, head + 1);
        if (kind === 'cross-block') tr.insertText('X', 1);
        if (kind !== 'ordinary typing') tr.setMeta('composition', 1);
        sync.dispatch(tr);
      };
      sync = new MarkdownEditorModel(model, [], () => {}, undefined, enqueue);
      const last = model.onDidChangeContent(event => {
        if (event.versionId === 2 && kind === 'skipped version') {
          applyOffsets(model, 11, 25, '');
        }
      });
      const other = new MarkdownEditorModel(model, [], () => {});
      try {
        placeAtomCaret(sync, 1, 1);
        if (kind === 'skipped version') {
          // The reload event is read first. On its delivery, v4 (deletion) arrives before v3 (prefix).
          model.setValue(original);
        } else {
          applyOffsets(model, 7, 21, '');
        }
        const expected = recovers ? external.replace('Last', '요\n\nLast') : external;
        const expectSource = (source: string) => {
          const parsed = parseMarkdownWithSource(source).doc;
          expect(model.getValue()).toBe(source);
          expect(sync.state.doc.eq(parsed)).toBe(true);
          expect(other.state.doc.eq(parsed)).toBe(true);
        };
        expectSource(expected);
        if (recovers) {
          expect(sync.state.selection.$head.parent.textContent).toBe('요');
          expect(sync.state.selection.$head.parentOffset).toBe(1);
          expect(sync.undo()).toBe(true);
          expectSource(external);
        }
        expect(sync.undo()).toBe(true);
        expectSource(original);
        expect(sync.canUndo).toBe(false);
        expect(sync.redo()).toBe(true);
        expectSource(external);
        if (recovers) {
          expect(sync.redo()).toBe(true);
          expectSource(expected);
        }
        expect(sync.canRedo).toBe(false);
      } finally {
        first.dispose();
        last.dispose();
        other.dispose();
        sync.dispose();
        model.dispose();
      }
    },
  );

  it.each([-1, 1] as const)('recovers the pending composition when the source loses its only block (%s)', side => {
    const original = '---';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      if (markdownCaretParagraphSide(sync.state.selection.$head.parent) !== undefined) {
        sync.dispatch(sync.state.tr.insertText('요').setMeta('composition', 1));
      }
    });
    try {
      placeRuleCaret(sync, 0, side);
      applyOffsets(model, 0, original.length, '');
      const expectSource = (source: string) => {
        expect(model.getValue()).toBe(source);
        expect(sync.state.doc.eq(parseMarkdownWithSource(source).doc)).toBe(true);
      };
      expectSource('요');
      expect(sync.state.selection.$head.parent.textContent).toBe('요');
      expect(sync.undo()).toBe(true);
      expectSource('');
      expect(sync.undo()).toBe(true);
      expectSource(original);
      expect(sync.redo()).toBe(true);
      expectSource('');
      expect(sync.redo()).toBe(true);
      expectSource('요');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('undoes a recovered composition and its later updates together', () => {
    const original = 'First\n\n[ref]: /path\n\nLast';
    const external = 'First\n\nLast';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      if (markdownCaretParagraphSide(sync.state.selection.$head.parent) !== undefined) {
        sync.dispatch(sync.state.tr.insertText('요').setMeta('composition', 1));
      }
    });
    try {
      placeAtomCaret(sync, 1, 1);
      applyOffsets(model, 7, 21, '');
      expect(model.getValue()).toBe('First\n\n요\n\nLast');
      const { head } = sync.state.selection;
      sync.dispatch(sync.state.tr.insertText('욤', head - 1, head).setMeta('composition', 1));
      expect(model.getValue()).toBe('First\n\n욤\n\nLast');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(external);
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.canUndo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('recovers only the last composition queued for one lost paragraph', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n[ref]: /path\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      const { state } = sync;
      if (markdownCaretParagraphSide(state.selection.$head.parent) === undefined) return;
      // Both flushes read the DOM against the same deferred state. The second IME composition
      // therefore also contains the first one's committed text.
      sync.dispatch(state.tr.insertText('요').setMeta('composition', 1));
      sync.dispatch(state.tr.insertText('요리').setMeta('composition', 2));
    });
    try {
      placeAtomCaret(sync, 1, 1);
      applyOffsets(model, 7, 21, '');
      expect(model.getValue()).toBe('First\n\n요리\n\nLast');
      expect(sync.state.doc.eq(parseMarkdownWithSource('First\n\n요리\n\nLast').doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps a gutter caret beside a repeated rule when a batch leaves the text unchanged', () => {
    const original = 'A\n\n---\n\nB\n\n---';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      const caret = sync.state.selection.$head.parent;
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'A' },
        { range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 4 }, text: '---' },
      ]);
      expect(model.getValue()).toBe(original);
      expect(sync.state.selection.$head.parent).toBe(caret);
      expect(sync.state.selection.$head.before()).toBe(sync.state.doc.child(0).nodeSize + sync.state.doc.child(1).nodeSize);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps an extended range when its anchor leaves with the temporary paragraph', () => {
    const original = 'First\n\n---\n\nLast';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, -1);
      const { doc, selection, tr } = sync.state;
      sync.dispatch(tr.setSelection(TextSelection.create(doc, selection.anchor, doc.content.size - 1)));
      expect(sync.state.doc.eq(parseMarkdownWithSource(original).doc)).toBe(true);
      expect(sync.state.selection.$anchor.parent.textContent).toBe('First');
      expect(sync.state.selection.$head.parent.textContent).toBe('Last');
      expect(model.getVersionId()).toBe(1);
      expect(sync.canUndo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { side: 1, head: 'Last', removed: 'First\n\n---\n\nst' },
    { side: -1, head: 'First', removed: 'Fi\n\n---\n\nLast' },
  ] as const)('leaves the target rule out when a range leaves the temporary paragraph ($side)', ({ side, head, removed }) => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, side);
      const { doc, selection, tr } = sync.state;
      // Extend away from the rule: down into Last below it, or up into First above it.
      sync.dispatch(tr.setSelection(TextSelection.create(doc, selection.anchor, side === 1 ? selection.anchor + 4 : 3)));
      expect(sync.state.selection.$anchor.parent.textContent).toBe(head);
      sync.dispatch(sync.state.tr.deleteSelection());
      expect(model.getValue()).toBe(removed);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('restores a text range, not the rule, when undoing typing over a range ending in the temporary paragraph', () => {
    const original = 'First\n\n---\n\nLast';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, -1);
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, 3, sync.state.selection.head)));
      sync.dispatch(sync.state.tr.insertText('X'));
      expect(model.getValue()).toBe('FiX\n\n---\n\nLast');
      expect(sync.undo()).toBe(true);
      expect(model.getValue()).toBe(original);
      expect(sync.state.selection).toBeInstanceOf(TextSelection);
      sync.dispatch(sync.state.tr.insertText('Y'));
      expect(model.getValue()).toBe('FiY\n\n---\n\nLast');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps the range anchor when an external change leaves no gap for the temporary paragraph', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\nMid\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 2, -1);
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, 2, sync.state.selection.head)));
      model.applyEdits([{ range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 4 }, text: '***' }]);
      expect(sync.state.selection.anchor).toBe(2);
      expect(sync.state.selection.$head.parent.textContent).toBe('Mid');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('rebases a queued replacement of the whole temporary paragraph over a source batch', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {}, undefined, () => {
      const { state } = sync;
      const { $head } = state.selection;
      const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text('Pasted'));
      sync.dispatch(state.tr.replaceWith($head.before(), $head.after(), paragraph).setMeta('uiEvent', 'paste'));
    });
    try {
      placeRuleCaret(sync, 1, 1);
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }, text: 'Altered' },
        { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 5 }, text: 'Replaced' },
      ]);
      expect(model.getValue()).toBe('Altered\n\n---\n\nPasted\n\nReplaced');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps the temporary paragraph when one source edit rewrites the text around and over the rule', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      // A minimal reload diff starts in the first block and ends in the last one.
      model.applyEdits([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 5 }, text: 'Primo\n\n---\n\nUltimo' }]);
      expect(sync.state.selection.$head.parent.textContent).toBe('');
      sync.dispatch(sync.state.tr.insertText('Added'));
      expect(model.getValue()).toBe('Primo\n\n---\n\nAdded\n\nUltimo');
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps stored marks set by the first input in the temporary paragraph', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      const { head } = sync.state.selection;
      const strong = sync.state.schema.marks.strong.create();
      sync.dispatch(sync.state.tr.insertText('A', head, head).setStoredMarks([strong]));
      expect(sync.state.storedMarks).toEqual([strong]);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps a read-only caret between atoms through a source change', async () => {
    await import('../../browser/markdownEditorGutter.js');
    const model = new TestTextModel(URI.parse('file:///draft.md'), '---');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const gap = Selection.fromJSON(sync.state.doc, { type: 'markdownReadOnlyGap', pos: 0 });
      sync.dispatch(sync.state.tr.setSelection(gap));
      model.applyEdits([{ range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 4 }, text: '\n\n***' }]);
      expect(sync.state.selection).not.toBeInstanceOf(NodeSelection);
      expect(sync.state.selection.empty).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps an empty split of the temporary paragraph out of the document history', () => {
    const original = 'First\n\n---\n\nLast';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      sync.dispatch(sync.state.tr.split(sync.state.selection.head));
      expect(sync.state.doc.childCount).toBe(4);
      expect(sync.canUndo).toBe(false);
      expect(model.getVersionId()).toBe(1);
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, 1)));
      expect(sync.state.doc.eq(parseMarkdownWithSource(original).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([-1, 1] as const)('records one empty paragraph when baseKeymap handles Enter in gutter %s', side => {
    const original = 'First\n\n\n---\n \t\n\nLast\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      const source = sync.state.doc;
      placeRuleCaret(sync, 1, side);
      const start = sync.state.selection.head;
      const checkEnter = () => {
        const { doc, selection } = sync.state;
        expect(doc.childCount).toBe(source.childCount + 2);
        const authored = doc.nodeAt(start - 1)!;
        expect(authored.type.name).toBe('paragraph');
        expect(authored.childCount).toBe(0);
        expect(markdownCaretParagraphSide(authored)).toBeUndefined();
        expect(selection.head).toBe(start + authored.nodeSize);
        expect(markdownCaretParagraphSide(selection.$head.parent)).toBe(side);
        expect(model.getValue()).toBe(original);
        expect(model.getVersionId()).toBe(1);
      };
      expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
      checkEnter();
      if (side === -1) {
        sync.dispatch(sync.state.tr.setSelection(TextSelection.create(sync.state.doc, 1)));
        expect(sync.state.doc.childCount).toBe(source.childCount + 1);
        expect(sync.state.doc.nodeAt(start - 1)?.textContent).toBe('');
      }

      expect(sync.undo()).toBe(true);
      expect(sync.canUndo).toBe(false);
      expect(sync.state.doc.eq(source)).toBe(true);
      expect(model.getVersionId()).toBe(1);
      expect(sync.redo()).toBe(true);
      checkEnter();

      sync.dispatch(sync.state.tr.insertText('Added'));
      expect(model.getValue()).toBe(side === -1 ? 'First\n\nAdded\n\n---\n \t\n\nLast\n'
        : 'First\n\n\n---\n\nAdded\n\nLast\n');
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.childCount).toBe(source.childCount + 1);
      expect(model.getValue()).toBe(original);
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.eq(source)).toBe(true);
      expect(sync.canUndo).toBe(false);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('undoes a deletion spanning the authored blank and its temporary continuation', () => {
    const original = 'First\n\n---\n\nLast\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, -1);
      expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
      const { doc, selection } = sync.state;
      sync.dispatch(sync.state.tr.setSelection(TextSelection.create(doc, doc.child(0).nodeSize - 1, selection.head)));
      expect(baseKeymap.Backspace(sync.state, tr => sync.dispatch(tr))).toBe(true);
      expect(sync.state.doc.childCount).toBe(3);
      expect(model.getValue()).toBe(original);
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.childCount).toBe(4);
      expect(sync.state.doc.child(1).textContent).toBe('');
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.childCount).toBe(3);
      expect(model.getValue()).toBe(original);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it.each([
    { side: -1, line: 9, written: 'First\n\n---\n\nMid\n\nAdded\n\n---\n\nLast!\n' },
    { side: 1, line: 1, written: 'Firs!t\n\n---\n\nMid\n\n---\n\nAdded\n\nLast\n' },
  ] as const)('keeps the temporary paragraph at a repeated rule when the source changes after Enter in gutter $side',
    ({ side, line, written }) => {
      const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n---\n\nMid\n\n---\n\nLast\n');
      const sync = new MarkdownEditorModel(model, [], () => {});
      try {
        placeRuleCaret(sync, 3, side);
        expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
        editLine(model, line, 5, 5, '!');
        const { $head } = sync.state.selection;
        expect(markdownCaretParagraphSide($head.parent)).toBe(side);
        const rule = side === 1 ? sync.state.doc.resolve($head.before()).nodeBefore
          : sync.state.doc.resolve($head.after()).nodeAfter;
        expect(rule?.type.name).toBe('horizontal_rule');
        // The Enter blank leaves with the source change, and the caret stays beside the second rule.
        expect($head.index(0)).toBe(side === 1 ? 4 : 3);
        sync.dispatch(sync.state.tr.insertText('Added'));
        expect(model.getValue()).toBe(written);
      } finally {
        sync.dispose();
        model.dispose();
      }
    });

  it('keeps the authored blank ahead of its temporary continuation through a source batch with identical text', () => {
    const original = 'First\n\n---\n\nLast\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
      const head = sync.state.selection.head;
      const gap = sync.state.selection.$head.before();
      const authored = sync.state.doc.resolve(gap).nodeBefore;
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, text: 'F' },
        { range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 2 }, text: 'L' },
      ]);
      expect(model.getValue()).toBe(original);
      expect(sync.state.selection.head).toBe(head);
      expect(markdownCaretParagraphSide(sync.state.selection.$head.parent)).toBe(1);
      expect(sync.state.doc.resolve(gap).nodeBefore).toBe(authored);
      expect(sync.undo()).toBe(true);
      expect(sync.canUndo).toBe(false);
      expect(sync.state.doc.eq(parseMarkdownWithSource(original).doc)).toBe(true);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('undoes removal of both Enter paragraphs after the final rule', () => {
    const original = 'First\n\n---\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 1, 1);
      const gap = sync.state.selection.$head.before();
      expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
      // Delete the full blocks, including the final temporary paragraph.
      sync.dispatch(sync.state.tr.delete(gap, sync.state.doc.content.size));
      expect(sync.state.doc.childCount).toBe(2);
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.childCount).toBe(3);
      expect(sync.state.doc.lastChild?.type.name).toBe('paragraph');
      expect(sync.state.doc.lastChild?.content.size).toBe(0);
      expect(sync.undo()).toBe(true);
      expect(sync.state.doc.childCount).toBe(2);
      expect(model.getValue()).toBe(original);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('preserves gaps around a changed heading while a middle Enter blank is still visible', () => {
    const original = '# First\n\n\nSecond\n\n---\n\nLast\n';
    const model = new TestTextModel(URI.parse('file:///draft.md'), original);
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      placeRuleCaret(sync, 2, 1);
      expect(baseKeymap.Enter(sync.state, tr => sync.dispatch(tr))).toBe(true);
      const { doc, tr } = sync.state;
      sync.dispatch(tr.setNodeMarkup(0, undefined, { ...doc.child(0).attrs, level: 2 }));
      expect(sync.state.doc.childCount).toBe(6);
      expect(model.getValue()).toBe('#' + original);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('passes edited block marks to serialization when reattaching incremental source attrs', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'First\n\n\nMiddle\n\nLast');
    const sync = new MarkdownEditorModel(model, [], () => {});
    const serialize = vi.spyOn(markdownSerialization, 'serializeMarkdown');
    // The current Markdown schema excludes top-level marks. Allow one here to exercise the
    // handoff of a marked block to the serializer independently of the schema and its spelling.
    const allowBlockMarks = vi.spyOn(sync.state.doc.type, 'allowsMarks').mockReturnValue(true);
    try {
      editLine(model, 1, 6, 6, '!');
      const { doc, tr, schema } = sync.state;
      const from = doc.child(0).nodeSize;
      const mark = schema.marks.strong.create();
      tr.insertText('!', from + 1);
      const block = tr.doc.child(1);
      sync.dispatch(tr.replaceWith(from, from + block.nodeSize, block.mark([mark])));
      expect(sync.state.doc.child(1).attrs).toBe(doc.child(1).attrs);
      const writtenBlock = serialize.mock.lastCall?.[0].child(1);
      expect(writtenBlock?.attrs).not.toBe(doc.child(1).attrs);
      expect(writtenBlock?.textContent).toBe('!Middle');
      expect(writtenBlock?.marks).toEqual([mark]);
    } finally {
      allowBlockMarks.mockRestore();
      serialize.mockRestore();
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps edited source gaps when an empty paragraph is added after a final rule', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), '\nFirst\n\n\n\nSecond\n  \n---\n');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      sync.dispatch(sync.state.tr.insertText('!', 6));
      const edited = model.getValue();
      expect(edited).toBe('\nFirst!\n\n\n\nSecond\n  \n---\n');
      const version = model.getVersionId();
      const end = sync.state.doc.content.size;
      sync.dispatch(sync.state.tr.insert(end, sync.state.schema.nodes.paragraph.create()).setMeta('addToHistory', false));
      expect(model.getValue()).toBe(edited);
      expect(model.getVersionId()).toBe(version);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });

  it('keeps edited source gaps when an empty caret paragraph sits before a middle rule', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), '\nFirst\n\n\n\nSecond\n  \n---\n\nLast\n');
    const sync = new MarkdownEditorModel(model, [], () => {});
    try {
      sync.dispatch(sync.state.tr.insertText('!', 6));
      const edited = model.getValue();
      expect(edited).toBe('\nFirst!\n\n\n\nSecond\n  \n---\n\nLast\n');
      const version = model.getVersionId();
      let rule = -1;
      sync.state.doc.forEach((node, offset) => {
        if (node.type.name === 'horizontal_rule') rule = offset;
      });
      const caret = createMarkdownCaretParagraph(sync.state.schema.nodes.paragraph, -1);
      const tr = sync.state.tr.insert(rule, caret);
      sync.dispatch(tr.setSelection(TextSelection.create(tr.doc, rule + 1))
        .setMeta(markdownCaretParagraphKey, true).setMeta('addToHistory', false));
      expect(sync.state.doc.childCount).toBe(5);
      expect(model.getValue()).toBe(edited);
      expect(model.getVersionId()).toBe(version);
    } finally {
      sync.dispose();
      model.dispose();
    }
  });
});
