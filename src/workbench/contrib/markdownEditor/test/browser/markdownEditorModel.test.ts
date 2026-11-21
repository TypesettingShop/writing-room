import { toggleMark } from 'prosemirror-commands';
import { undo } from 'prosemirror-history';
import { InputRule, inputRules, undoInputRule } from 'prosemirror-inputrules';
import type { EditorState } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { parseMarkdownWithSource } from '../../../../../editor/common/markdown/parser.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { MarkdownEditorModel } from '../../browser/markdownEditorModel.js';

function editLine(model: TestTextModel, line: number, startColumn: number, endColumn: number, text: string): void {
  model.applyEdits([{ range: { startLineNumber: line, startColumn, endLineNumber: line, endColumn }, text }]);
}

describe('MarkdownEditorModel', () => {
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

  it('drops a queued edit in a batch that moves the blocks instead of moving it to another block', () => {
    const model = new TestTextModel(URI.parse('file:///draft.md'), 'Alpha\n\nBravo\n\nCharlie');
    let sync: MarkdownEditorModel;
    model.onDidChangeContent(event => {
      if (event.versionId === 2) {
        const end = sync.state.doc.child(0).nodeSize + sync.state.doc.child(1).nodeSize - 1;
        sync.dispatch(sync.state.tr.insertText('X', end));
      }
    });
    sync = new MarkdownEditorModel(model, [], () => {});
    try {
      model.applyEdits([
        { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }, text: '' },
        { range: { startLineNumber: 5, startColumn: 8, endLineNumber: 5, endColumn: 8 }, text: '\n\nDelta' },
      ]);
      expect(model.getValue()).not.toContain('CharlieX');
      expect(sync.state.doc.eq(parseMarkdownWithSource(model.getValue()).doc)).toBe(true);
    } finally {
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
});
