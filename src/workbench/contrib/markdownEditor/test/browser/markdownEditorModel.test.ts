import { toggleMark } from 'prosemirror-commands';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { TestTextModel } from '../../../../../editor/test/common/testTextModel.js';
import { MarkdownEditorModel } from '../../browser/markdownEditorModel.js';

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
});
