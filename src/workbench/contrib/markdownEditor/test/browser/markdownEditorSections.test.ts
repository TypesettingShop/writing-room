// @vitest-environment node
import { EditorState, TextSelection } from 'prosemirror-state';
import { expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { markdownSections, markdownSectionsKey, markdownSectionStarts } from '../../browser/markdownEditorSections.js';

it('counts top-level separators and numbers the first eligible block per section', () => {
  const doc = parseMarkdown('a\n\n---\n\n> ***\n>\n> x\n\nb\n\n***\n\n- a list\n\n___\n\n# c\n\nd');
  expect(markdownSectionStarts(doc).map(({ from, section }) => [doc.nodeAt(from)?.textContent, section]))
    .toEqual([['a', 1], ['b', 2], ['c', 4]]);
});

it('reuses decorations for selection changes and leaves them empty when disabled', () => {
  let enabled = false;
  const doc = parseMarkdown('a\n\n---\n\nb');
  let state = EditorState.create({ doc, plugins: [markdownSections(() => enabled)] });
  const decorations = () => markdownSectionsKey.getState(state);
  expect(decorations()).toBeNull();
  state = state.apply(state.tr.insertText('x', 1));
  expect(decorations()).toBeNull();

  enabled = true;
  state = state.apply(state.tr);
  const first = decorations();
  expect(first?.find()).toHaveLength(2);
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
  expect(decorations()).toBe(first);
  state = state.apply(state.tr.insertText('y', 1));
  expect(decorations()).not.toBe(first);

  enabled = false;
  state = state.apply(state.tr);
  expect(decorations()).toBeNull();
});
