import { toggleMark } from 'prosemirror-commands';
import type { EditorState } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
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
});
