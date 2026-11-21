// @vitest-environment jsdom
import { undoInputRule } from 'prosemirror-inputrules';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { markdownInputRules } from '../../browser/markdownEditorInputRules.js';

interface RuleCase {
  readonly input: string;
  readonly node: string;
  readonly attrs?: Record<string, string | number | boolean>;
  readonly child?: string;
  readonly childAttrs?: Record<string, boolean>;
  readonly mark?: string;
  readonly beforeUndo?: string;
}

describe('Markdown typing shortcuts', () => {
  const cases: RuleCase[] = [
    ...Array.from({ length: 6 }, (_, index) => ({
      input: '#'.repeat(index + 1) + ' ', node: 'heading', attrs: { level: index + 1 },
    })),
    { input: '- ', node: 'bullet_list', attrs: { bullet: '-' } },
    { input: '* ', node: 'bullet_list', attrs: { bullet: '*' } },
    { input: '1. ', node: 'ordered_list', attrs: { order: 1 } },
    { input: '[ ] ', node: 'bullet_list', child: 'task_item', childAttrs: { checked: false } },
    { input: '[x] ', node: 'bullet_list', child: 'task_item', childAttrs: { checked: true } },
    { input: '- [ ] ', node: 'bullet_list', child: 'task_item', childAttrs: { checked: false }, beforeUndo: '[ ] ' },
    { input: '> ', node: 'blockquote' },
    { input: '```', node: 'code_block' },
    { input: '---', node: 'horizontal_rule' },
    { input: '**x**', node: 'paragraph', mark: 'strong' },
    { input: '*x*', node: 'paragraph', mark: 'em' },
    { input: '~~x~~', node: 'paragraph', mark: 'strike' },
    { input: '`x`', node: 'paragraph', mark: 'code' },
  ];
  it.each(cases)('converts $input and restores the typed marker with Backspace', ({
    input, node, attrs, child, childAttrs, mark, beforeUndo,
  }) => {
    const view = new EditorView(null, { state: EditorState.create({ doc: parseMarkdown(''), plugins: [markdownInputRules] }) });
    try {
      for (const character of input) {
        const { from, to } = view.state.selection;
        const insert = () => view.state.tr.insertText(character, from, to);
        if (!view.someProp('handleTextInput', handler => handler(view, from, to, character, insert))) {
          view.dispatch(insert());
        }
      }
      view.state.doc.check();
      const block = view.state.doc.firstChild!;
      expect(block.type.name).toBe(node);
      if (attrs) expect(block.attrs).toMatchObject(attrs);
      if (child) expect(block.firstChild?.type.name).toBe(child);
      if (childAttrs) expect(block.firstChild?.attrs).toMatchObject(childAttrs);
      if (mark) expect(block.firstChild?.marks[0]?.type.name).toBe(mark);
      expect(undoInputRule(view.state, tr => view.dispatch(tr))).toBe(true);
      expect(view.state.doc.textContent).toBe(beforeUndo ?? input);
    } finally {
      view.destroy();
    }
  });
});

describe('Markdown mark shortcuts over inline content', () => {
  it('keeps links, images and line breaks inside the converted span', () => {
    const source = parseMarkdown('[world](https://x.test/) ![i](x.png) y\\\nz').firstChild!;
    const { schema } = source.type;
    const [link, , image, , lineBreak] = Array.from({ length: source.childCount }, (_, index) => source.child(index));
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [
      schema.text('**a '), link, schema.text(' '), image, lineBreak, schema.text('b*'),
    ])]);
    const view = new EditorView(null, {
      state: EditorState.create({ doc, selection: TextSelection.atEnd(doc), plugins: [markdownInputRules] }),
    });
    try {
      const { from, to } = view.state.selection;
      const insert = () => view.state.tr.insertText('*', from, to);
      expect(view.someProp('handleTextInput', handler => handler(view, from, to, '*', insert))).toBe(true);
      view.state.doc.check();
      expect(serializeMarkdown(view.state.doc)).toBe('**a [world](https://x.test/) ![i](x.png)\\\nb**');
    } finally {
      view.destroy();
    }
  });
});
