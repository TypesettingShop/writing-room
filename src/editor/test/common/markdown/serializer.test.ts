// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { createMarkdownParser, parseMarkdown } from '../../../common/markdown/parser.js';
import { markdownSchema } from '../../../common/markdown/schema.js';
import { serializeMarkdown } from '../../../common/markdown/serializer.js';

const corpus = new URL('./corpus/', import.meta.url);
const fixtures = readdirSync(corpus).filter(name => name.endsWith('.md')).sort()
  .map(name => [name, readFileSync(new URL(name, corpus), 'utf8')] as const);

function canonical(doc: Node): string {
  return serializeMarkdown(doc, { preserveSource: false });
}

function editText(doc: Node, text: string, replacement: string): Node {
  let position = -1;
  doc.descendants((node, offset) => {
    if (position === -1 && node.text?.includes(text)) position = offset + node.text.indexOf(text);
  });
  expect(position).toBeGreaterThanOrEqual(0);
  const state = EditorState.create({ doc });
  return state.apply(state.tr.insertText(replacement, position, position + text.length)).doc;
}

function normalizedTree(doc: Node): unknown {
  const attrs = { ...doc.attrs };
  if (doc.type.name === 'code_block') delete attrs.markup;
  return {
    type: doc.type.name,
    attrs,
    text: doc.text,
    marks: doc.marks.map(mark => mark.toJSON()),
    children: Array.from({ length: doc.childCount }, (_, index) => normalizedTree(doc.child(index))),
  };
}

describe('Markdown corpus', () => {
  it('covers at least twenty sources', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
  });

  it.each(fixtures)('preserves unedited source and checks canonical stability for %s', (_name, source) => {
    const doc = parseMarkdown(source);
    doc.check();
    expect(serializeMarkdown(doc)).toBe(source);
    const written = canonical(doc);
    const saved = parseMarkdown(written);
    saved.check();
    expect(normalizedTree(saved)).toEqual(normalizedTree(doc));
    expect(canonical(saved)).toBe(written);
  });
});

describe('Markdown save normalization', () => {
  it.each([
    ['Heading\n=======', '# Heading'],
    ['Alpha  \nBeta', 'Alpha\\\nBeta'],
    ['- parent\n  + child', '- parent\n  + child'],
    ['7) one\n9) two', '7) one\n8) two'],
    ['- [X] done', '- [x] done'],
    ['    a\n    b', '```\na\nb\n```'],
    ['~~~ ts\nx\n~~~', '~~~ts\nx\n~~~'],
    ['|a|b|\n|-:|:-|\n| c | d|', '| a | b |\n| ---: | :--- |\n| c | d |'],
    ['> quote {.right}', '> quote\n\n{.right}'],
    ['[ref][x]\n\n[x]: /path', '[ref](/path)\n\n[x]: /path'],
    ['literal <em> &amp; {.Bad}', 'literal \\<em> \\& \\{.Bad}'],
    ['a\r\n\r\nb\r\n', 'a\n\nb'],
  ])('rewrites %j to %j when source retention is disabled', (source, expected) => {
    expect(canonical(parseMarkdown(source))).toBe(expected);
  });

  it('retains unchanged blocks and their separators through a transaction', () => {
    const source = ' 첫째   \r\n\r\n\r\nmiddle\r\n\r\n' +
      '~~~ spaced-info\r\ncode\r\n~~~\r\n\r\n' +
      '  *   untouched\r\n  *   _keep_\r\n';
    const doc = parseMarkdown(source);
    const position = doc.child(0).nodeSize + 1;
    const state = EditorState.create({ doc });
    const { doc: edited } = state.apply(state.tr.insertText('new middle', position, position + 'middle'.length));
    expect(serializeMarkdown(edited)).toBe(source.replace('middle', 'new middle'));
  });

  it('keeps a single-newline separator between untouched blocks and writes an edited block with the file line ending', () => {
    const source = '# 제목\r\nfirst\r\n\r\n> quote\r\n> more\r\n';
    const doc = parseMarkdown(source);
    const state = EditorState.create({ doc });
    const position = doc.child(0).nodeSize + doc.child(1).nodeSize + 2;
    const edited = state.apply(state.tr.insertText('new ', position)).doc;
    expect(serializeMarkdown(edited)).toBe('# 제목\r\nfirst\r\n\r\n> new quote\r\n> more\r\n');
  });

  it('writes loose lists with blank lines and intraword emphasis with asterisks', () => {
    expect(canonical(parseMarkdown('- a\n\n- b'))).toBe('- a\n\n- b');
    const underscore = markdownSchema.marks.em.create({ markup: '_' });
    const p = markdownSchema.nodes.paragraph.create(null, [
      markdownSchema.text('snake'), markdownSchema.text('case', [underscore]), markdownSchema.text(' _ok_ '),
      markdownSchema.text('word', [underscore]),
    ]);
    const written = canonical(markdownSchema.nodes.doc.create(null, p));
    expect(written).toBe('snake*case* \\_ok\\_ _word_');
  });

  it.each([
    ['loose bullet', '- a\n\n  {.x}', '- a\n\n  {.x}', false, ['x']],
    ['loose ordered', '7) a\n\n   {.x}', '7) a\n\n   {.x}', false, ['x']],
    ['loose task with item classes', '- [x] a {.item}\n\n  {.x .y}', '- [x] a {.item}\n\n  {.x .y}', false, ['x', 'y']],
    ['tight with a paragraph class', '- a\n  {.x}', '- a\n  {.x}', true, ['x']],
    ['loose with two items', '- a\n\n  {.x}\n- b', '- a\n  {.x}\n\n- b', false, ['x']],
    ['loose with two paragraphs', '- a\n\n  {.x}\n\n  b', '- a\n  {.x}\n\n  b', false, ['x']],
    ['plain loose', '- a\n\n- b', '- a\n\n- b', false, []],
    ['plain tight', '- a\n- b', '- a\n- b', true, []],
  ] as const)('preserves %s list spacing and paragraph classes on save', (_name, source, expected, tight, classes) => {
    const doc = parseMarkdown(source);
    const list = doc.firstChild!;
    expect(list.attrs.tight).toBe(tight);
    expect(list.firstChild!.firstChild!.attrs.classes).toEqual(classes);
    expect(serializeMarkdown(doc)).toBe(source);

    const normalized = canonical(doc);
    expect.soft(normalized).toBe(expected);
    expect.soft(parseMarkdown(normalized).eq(doc)).toBe(true);

    const state = EditorState.create({ doc });
    const edited = state.apply(state.tr.insertText('edited', 3, 4)).doc;
    const saved = serializeMarkdown(edited);
    expect(saved).toBe(expected.replace(' a', ' edited'));
    expect(parseMarkdown(saved).eq(edited)).toBe(true);
  });

  it('retains the blank line inside a quoted loose list with a paragraph class', () => {
    const doc = parseMarkdown('> - a\n>\n>   {.x}');
    const written = canonical(doc);
    expect(written).toBe('> - a\n>\n>   {.x}');
    expect(parseMarkdown(written).eq(doc)).toBe(true);
  });

  it.each([
    ['opening fence', '- ```\n    a\n  ```', 'a'],
    ['nested siblings', '- - a\n    - b', 'b'],
    ['nested paragraphs', '- - a\n\n    b', 'b'],
    ['nested loose class trailer', '- - a\n\n    {.x}', 'a'],
    ['deep loose class trailer', '- - - a\n\n      {.x}', 'a'],
    ['quoted nested loose class trailer', '> - - a\n>\n>     {.x}', 'a'],
    ['ordered nested loose class trailer', '- 1. a\n\n     {.x}', 'a'],
    ['quoted ordered continuations across marker widths',
      '> 9) - a\n>      - b\n> 10) - c\n>       - d', 'd'],
  ] as const)('keeps the content column in %s on repeated saves', (_name, source, text) => {
    const doc = parseMarkdown(source);
    const written = canonical(doc);
    const reparsed = parseMarkdown(written);
    expect.soft(written).toBe(source);
    expect.soft(reparsed.eq(doc)).toBe(true);
    expect.soft(canonical(reparsed)).toBe(written);

    const edited = editText(doc, text, 'edited');
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe(source.replace(text, 'edited'));
    expect(parseMarkdown(saved).eq(edited)).toBe(true);
  });

  it.each([
    ['tight fence', '- a\n  ```\n  b\n  ```', true, 'code_block'],
    ['tight quote', '- a\n  > b', true, 'blockquote'],
    ['loose fence', '- a\n\n  ```\n  b\n  ```', false, 'code_block'],
    ['loose quote', '- a\n\n  > b', false, 'blockquote'],
    ['tight fence with classes', '- a\n  ```\n  b\n  ```\n  {.code}', true, 'code_block'],
    ['tight quote with classes', '- a\n  > b\n  >\n  {.quote}', true, 'blockquote'],
    ['tight quote before a paragraph', '- a\n  > b\n  >\n  c', true, 'blockquote'],
    ['tight fence before a paragraph', '- a\n  ```\n  b\n  ```\n  c', true, 'code_block'],
    ['tight quote in an ordered task', '9) [x] a\n   > b', true, 'blockquote'],
  ] as const)('preserves block boundaries in a %s on save', (_name, source, tight, block) => {
    const doc = parseMarkdown(source);
    const list = doc.firstChild!;
    const item = list.firstChild!;
    expect(list.attrs.tight).toBe(tight);
    expect(item.child(0).type.name).toBe('paragraph');
    expect(item.child(1).type.name).toBe(block);
    expect(item.child(1).textContent).toBe('b');

    const written = canonical(doc);
    expect.soft(written).toBe(source);
    expect.soft(parseMarkdown(written).eq(doc)).toBe(true);

    const edited = editText(doc, 'b', 'edited');
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe(source.replace('b', 'edited'));
    expect(parseMarkdown(saved).eq(edited)).toBe(true);
  });

  it('keeps a loose list loose when its emptied first paragraph is dropped', () => {
    const doc = parseMarkdown('- a\n\n  b\n  {.x}');
    const state = EditorState.create({ doc });
    const saved = serializeMarkdown(state.apply(state.tr.delete(3, 4)).doc);
    expect(saved).toBe('- b\n\n  {.x}');
    const list = parseMarkdown(saved).firstChild!;
    expect(list.attrs.tight).toBe(false);
    expect(list.firstChild!.firstChild!.attrs.classes).toEqual(['x']);
  });

  it('retains marker spellings around edits in the same block', () => {
    const source = '+ _italic_ __strong__ ``code`` old';
    const state = EditorState.create({ doc: parseMarkdown(source) });
    const start = state.doc.content.size - 6;
    const edited = state.apply(state.tr.insertText('new', start, start + 3)).doc;
    expect(serializeMarkdown(edited)).toBe(source.replace('old', 'new'));
  });

  it('widens a fence for new content and closes a previously open fence before an insertion', () => {
    const state = EditorState.create({ doc: parseMarkdown('~~~md\noriginal') });
    const paragraph = markdownSchema.nodes.paragraph.create(null, markdownSchema.text('after'));
    const inserted = state.apply(state.tr.insert(state.doc.content.size, paragraph)).doc;
    expect(serializeMarkdown(inserted)).toBe('~~~md\noriginal\n~~~\n\nafter');
    const widened = state.apply(state.tr.insertText('~~~~\n', 1)).doc;
    expect(serializeMarkdown(widened)).toBe('~~~~~md\n~~~~\noriginal\n~~~~~');
  });

  it('round-trips block, item, paragraph, span and cell classes written by ProseMirror', () => {
    const source = [
      '# 제목 {.center}',
      '',
      '> 인용',
      '> {.paragraph}',
      '',
      '{.quote}',
      '',
      '- 항목 {.item}',
      '  {.paragraph}',
      '',
      '{.list}',
      '',
      '| 표 {.header} | 말줄임 |',
      '| :---: | --- |',
      '| `x\\|y` {.code} | [끝]{.size-lg .unknown} |',
      '',
      '{.table}',
    ].join('\n');
    const doc = parseMarkdown(source);
    expect(canonical(doc)).toBe(source);
    expect(parseMarkdown(canonical(doc)).eq(doc)).toBe(true);

    const p = markdownSchema.nodes.paragraph.create({ classes: ['subtitle', 'unknown'] }, [
      markdownSchema.text('한글', [markdownSchema.marks.span.create({ classes: ['font-serif'] })]),
    ]);
    const created = markdownSchema.nodes.doc.create(null, p);
    expect(serializeMarkdown(created)).toBe('[한글]{.font-serif} {.subtitle .unknown}');
    expect(parseMarkdown(serializeMarkdown(created)).eq(created)).toBe(true);
  });

  it('retains unknown blocks from the tokenizer in canonical mode', () => {
    const parse = createMarkdownParser({
      plugins: [{ id: 'unknown', plugin: md => md.core.ruler.push('unknown', ({ tokens }) => {
        if (tokens[0]?.type === 'paragraph_open') tokens[0].type = 'unknown_open';
      }) }],
    });
    const source = 'literal {.Bad}\n*kept*';
    expect(canonical(parse(source).doc)).toBe(source);
  });
});

it('preserves link semantics when a reference definition is deleted', () => {
  const state = EditorState.create({ doc: parseMarkdown('[label]\n\n[label]: /old\n') });
  const edited = state.apply(state.tr.delete(state.doc.firstChild!.nodeSize, state.doc.content.size)).doc;
  expect(serializeMarkdown(edited)).toBe('[label](/old)\n');
  expect(parseMarkdown(serializeMarkdown(edited)).eq(edited)).toBe(true);
});

it('keeps a previously standalone literal class literal when a preceding block is inserted', () => {
  const state = EditorState.create({ doc: parseMarkdown('{.literal}') });
  const paragraph = markdownSchema.nodes.paragraph.create(null, markdownSchema.text('above'));
  const edited = state.apply(state.tr.insert(0, paragraph)).doc;
  expect(serializeMarkdown(edited)).toBe('above\n\n\\{.literal}');
  expect(parseMarkdown(serializeMarkdown(edited)).eq(edited)).toBe(true);
});

it('retains literal line-end spaces, heading punctuation and an empty URL with a title', () => {
  const source = '# \\#\n\n&#32;space&#32;\n\nliteral\n\\=\n\n[one](<> "title")';
  const doc = parseMarkdown(source);
  const written = canonical(doc);
  expect(parseMarkdown(written).eq(doc)).toBe(true);
});

it('chooses a delimiter absent from edited inline code content', () => {
  const p = markdownSchema.nodes.paragraph.create(null, markdownSchema.text('`` then `', [
    markdownSchema.marks.code.create({ markup: '`' }),
  ]));
  const doc = markdownSchema.nodes.doc.create(null, p);
  expect(canonical(doc)).toBe('``` `` then ` ```');
  expect(parseMarkdown(canonical(doc)).textContent).toBe(doc.textContent);
});

it('keeps all cells when a table gains a column before the header is extended', () => {
  const doc = parseMarkdown('| header |\n| --- |\n| value |');
  const row = doc.firstChild!.lastChild!;
  const cell = markdownSchema.nodes.table_cell.create(null, markdownSchema.text('extra'));
  const state = EditorState.create({ doc });
  const edited = state.apply(state.tr.insert(doc.content.size - 2, cell)).doc;

  expect(edited.firstChild!.lastChild!.childCount).toBe(row.childCount + 1);
  expect(canonical(edited)).toBe('| header |  |\n| --- | --- |\n| value | extra |');
  expect(parseMarkdown(canonical(edited)).firstChild!.lastChild!.lastChild!.textContent).toBe('extra');
});

it('keeps adjacent lists distinct when an intervening block is removed', () => {
  const doc = parseMarkdown('7. first\n\nmiddle\n\n3. second');
  const state = EditorState.create({ doc });
  const offset = doc.firstChild!.nodeSize;
  const edited = state.apply(state.tr.delete(offset, offset + doc.child(1).nodeSize)).doc;
  const written = serializeMarkdown(edited);
  expect(written).toBe('7. first\n\n3) second');
  const reparsed = parseMarkdown(written);
  expect(reparsed.childCount).toBe(2);
  expect(reparsed.lastChild!.attrs.order).toBe(3);
});

it('writes a nested ordered list starting after one as a list', () => {
  const { doc } = EditorState.create({ doc: parseMarkdown('- first\n    1. second') });
  const outer = doc.firstChild!;
  const item = outer.firstChild!;
  const nested = item.lastChild!;
  const changed = nested.type.create({ ...nested.attrs, order: 7 }, nested.content);
  const state = EditorState.create({ doc });
  const position = 2 + item.firstChild!.nodeSize;
  const edited = state.apply(state.tr.replaceWith(position, position + nested.nodeSize, changed)).doc;
  const written = canonical(edited);
  expect(written).toBe('- first\n\n  7. second');
  expect(parseMarkdown(written).firstChild!.firstChild!.lastChild!.attrs.order).toBe(7);
});

it('keeps list items that start with a block and saves empty tasks', () => {
  const source = '- > quote\n- [ ]\n- [x]';
  const doc = parseMarkdown(source);
  expect(canonical(doc)).toBe(source);
  expect(parseMarkdown(canonical(doc)).eq(doc)).toBe(true);
});
