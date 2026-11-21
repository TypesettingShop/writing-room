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

  it.each([
    ['first\nsecond {.title}\n=\n\nafter', 1, 'soft_break', '==='],
    ['- first  \n  second {.title}\n  -\n  after\n- tail', 2, 'hard_break', '  ---'],
  ] as const)('keeps a multiline Setext heading and its adjacent blocks in %j', (source, level, breakType, underline) => {
    const doc = parseMarkdown(source);
    const heading = level === 1 ? doc.firstChild! : doc.firstChild!.firstChild!.child(1);
    expect(heading.type.name).toBe('heading');
    expect(heading.attrs).toMatchObject({ level, classes: ['title'] });
    expect(heading.child(1).type.name).toBe(breakType);
    expect(serializeMarkdown(doc)).toBe(source);

    const edited = editText(doc, 'second', 'edited');
    for (const [target, written] of [[doc, canonical(doc)], [edited, serializeMarkdown(edited)]] as const) {
      expect.soft(written.split('\n')).toContain(underline);
      const reopened = parseMarkdown(written);
      expect.soft(reopened.toJSON()).toEqual(target.toJSON());
      expect.soft(canonical(reopened)).toBe(written);
    }
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
    ['> * ***\n>   {.x}\n>   {.y}', '****'],
    ['> {.x}\n> {.y}', null],
    ['- > {.x}\n  > {.y}\n- tail', null],
  ] as const)('saves the empty styled paragraph and its owners in %j', (source, ruleMarkup) => {
    const doc = parseMarkdown(source);
    let position = -1;
    doc.descendants((node, offset) => {
      if (node.type.name === 'blockquote') position = offset;
    });
    expect(position).toBeGreaterThanOrEqual(0);
    const quote = doc.nodeAt(position)!;
    const paragraph = quote.lastChild!;
    expect(quote.attrs.classes).toEqual(['x']);
    expect(quote.childCount).toBe(ruleMarkup ? 2 : 1);
    if (ruleMarkup) expect(quote.firstChild?.attrs).toMatchObject({ markup: ruleMarkup, classes: [] });
    expect(paragraph.type.name).toBe('paragraph');
    expect(paragraph.attrs.classes).toEqual(['y']);
    expect(paragraph.content.size).toBe(0);
    expect(serializeMarkdown(doc)).toBe(source);

    const state = EditorState.create({ doc });
    const paragraphPos = position + quote.nodeSize - paragraph.nodeSize - 1;
    const edited = state.apply(state.tr.setNodeMarkup(paragraphPos, undefined, { classes: ['edited'] })).doc;
    for (const [target, written, name] of [[doc, canonical(doc), 'y'], [edited, serializeMarkdown(edited), 'edited']] as const) {
      expect.soft(written).toContain(`> []{.${name}}`);
      const reopened = parseMarkdown(written);
      expect.soft(reopened.toJSON()).toEqual(target.toJSON());
      expect.soft(canonical(reopened)).toBe(written);
    }
  });

  it('keeps escaped bracket text in a quote and leaves the top-level spelling literal', () => {
    const doc = parseMarkdown('[]{.top}\n\n> \\[\\]\\{.quote}');
    expect(doc.firstChild?.textContent).toBe('[]{.top}');
    expect(doc.lastChild?.firstChild?.textContent).toBe('[]{.quote}');
    expect(parseMarkdown(canonical(doc)).toJSON()).toEqual(doc.toJSON());
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
    ['dash bullet', '-\n  ---', '-\n  ---', '-\n  ---\n  {.rule}', 'bullet_list', 1, true],
    ['asterisk bullets', '*\n  ***\n* tail', '*\n  ***\n* tail', '*\n  ***\n  {.rule}\n* tail', 'bullet_list', 2, true],
    ['width change in an ordered list', '9) head\n10) ---', '9) head\n10) ---', '9) head\n10) ---\n    {.rule}',
      'ordered_list', 2, true],
    ['nested list in a quote', '> - -\n>     ---', '> - -\n>     ---', '> - -\n>     ---\n>     {.rule}',
      'bullet_list', 1, true],
    ['three nested dash markers', '- -\n    -\n      ---', '- -\n    -\n      ---', '- -\n    -\n      ---\n      {.rule}',
      'bullet_list', 1, true],
    ['nested list interrupting a paragraph', '- text\n  - ___', '- text\n  - ___', '- text\n  - ___\n    {.rule}',
      'bullet_list', 1, true],
    ['two nested dash markers after a paragraph', '- text\n  - -\n      ---', '- text\n  - -\n      ---',
      '- text\n  - -\n      ---\n      {.rule}',
      'bullet_list', 1, true],
    ['loose list with a rule class', '-\n  ---\n\n  {.old}\n\n- tail', '-\n  ---\n\n  {.old}\n\n- tail',
      '-\n  ---\n\n  {.rule}\n\n- tail', 'bullet_list', 2, false],
    ['two nested dash markers in a loose item', '- text\n\n  - -\n      ---', '- text\n\n  - -\n      ---',
      '- text\n\n  - -\n      ---\n      {.rule}', 'bullet_list', 1, true],
  ] as const)('keeps the first rule inside its item (%s)', (_name, source, expected, editedSource, listType, count, tight) => {
    const doc = parseMarkdown(source);
    let rulePosition = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === 'horizontal_rule') rulePosition = pos;
    });
    expect(rulePosition).toBeGreaterThanOrEqual(0);
    const item = doc.resolve(rulePosition);
    const list = item.node(-1);
    expect(list.type.name).toBe(listType);
    expect(list.childCount).toBe(count);
    expect(list.attrs.tight).toBe(tight);
    expect(item.parent.childCount).toBe(2);
    expect(item.parent.firstChild!.type.name).toBe('paragraph');
    expect(item.parent.firstChild!.content.size).toBe(0);

    const normalized = canonical(doc);
    expect.soft(normalized).toBe(expected);
    expect.soft(parseMarkdown(normalized).eq(doc)).toBe(true);

    const state = EditorState.create({ doc });
    const rule = item.nodeAfter!;
    const edited = state.apply(state.tr.setNodeMarkup(rulePosition, undefined, { ...rule.attrs, classes: ['rule'] })).doc;
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe(editedSource);
    const reparsed = parseMarkdown(saved);
    expect.soft(reparsed.eq(edited)).toBe(true);
    expect.soft(canonical(reparsed)).toBe(saved);
  });

  it('keeps a rule before a paragraph in a tight list item', () => {
    const source = '-\n  ---\n  text';
    const doc = parseMarkdown(source);
    expect(doc.firstChild!.attrs.tight).toBe(true);
    expect.soft(canonical(doc)).toBe(source);
    const edited = editText(doc, 'text', 'edited');
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe('-\n  ---\n  edited');
    expect(parseMarkdown(saved).eq(edited)).toBe(true);
  });

  it.each([
    ['tight fence', '- a\n  ```\n  b\n  ```', true, 'code_block'],
    ['tight quote', '- a\n  > b', true, 'blockquote'],
    ['loose fence', '- a\n\n  ```\n  b\n  ```', false, 'code_block'],
    ['loose quote', '- a\n\n  > b', false, 'blockquote'],
    ['tight fence with classes', '- a\n  ```\n  b\n  ```\n  {.code}', true, 'code_block'],
    ['tight quote with classes', '- a\n  > b\n  >\n  {.quote}', true, 'blockquote'],
    ['tight quote with classes before a second quote', '- a\n  > b\n  >\n  {.quote}\n  > c', true, 'blockquote'],
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

  it.each([
    ['tight heading and following paragraph', '- lead\n  # heading {.heading}\n  tail', true,
      ['paragraph', 'heading', 'paragraph']],
    ['tight rule and its class trailer', '- lead\n  ***\n  {.rule}', true,
      ['paragraph', 'horizontal_rule']],
    ['tight dash rule after a task paragraph with classes',
      '9) [x] lead {.item}\n   {.p}\n   - - - -\n   {.rule}\n10) tail', true, ['paragraph', 'horizontal_rule']],
    ['tight dash rule after a quote with classes', '- > lead\n  >\n  {.quote}\n  - - -\n  {.rule}', true,
      ['paragraph', 'blockquote', 'horizontal_rule']],
    ['tight table before a heading', '- lead\n  | h |\n  | --- |\n  | b |\n  # tail', true,
      ['paragraph', 'table', 'heading']],
    ['tight table after a quote', '- > lead\n  >\n  | h |\n  | --- |\n  | b |', true,
      ['paragraph', 'blockquote', 'table']],
    ['tight item with adjacent bullet lists', '- lead\n  - one\n  * two', true, ['paragraph', 'bullet_list', 'bullet_list']],
    ['tight item with adjacent ordered lists', '- lead\n  1. one\n  1) two', true,
      ['paragraph', 'ordered_list', 'ordered_list']],
    ['loose heading', '- lead\n\n  # heading', false, ['paragraph', 'heading']],
    ['loose dash rule with a class', '- lead\n\n  ---\n\n  {.rule}', false, ['paragraph', 'horizontal_rule']],
    ['loose table with a class', '- lead\n\n  | h |\n  | --- |\n  | b |\n\n  {.table}', false, ['paragraph', 'table']],
  ] as const)('preserves the list block boundaries for a %s', (_name, source, tight, blockTypes) => {
    const doc = parseMarkdown(source);
    const list = doc.firstChild!;
    const item = list.firstChild!;
    expect(list.attrs.tight).toBe(tight);
    expect(Array.from({ length: item.childCount }, (_, index) => item.child(index).type.name)).toEqual(blockTypes);

    const normalized = canonical(doc);
    expect.soft(normalized).toBe(source);
    expect.soft(parseMarkdown(normalized).eq(doc)).toBe(true);

    const edited = editText(doc, 'lead', 'edited');
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe(source.replace('lead', 'edited'));
    const reparsed = parseMarkdown(saved);
    expect.soft(reparsed.eq(edited)).toBe(true);
    expect.soft(canonical(reparsed)).toBe(saved);
  });

  it('keeps a Setext heading distinct from a paragraph followed by a dash rule', () => {
    const heading = parseMarkdown('- lead\n  ---');
    expect(heading.firstChild!.firstChild!.child(1).type.name).toBe('heading');
    expect(canonical(heading)).toBe('- ## lead');
    expect(parseMarkdown(canonical(heading)).eq(heading)).toBe(true);

    const rule = parseMarkdown('- lead\n  - ---\n  {.rule}');
    const item = rule.firstChild!.firstChild!;
    expect(item.attrs.classes).toEqual([]);
    expect(item.firstChild!.attrs.classes).toEqual([]);
    expect(item.child(1).attrs.classes).toEqual(['rule']);
    expect.soft(canonical(rule)).toBe('- lead\n  - - - -\n  {.rule}');
    expect(parseMarkdown(canonical(rule)).eq(rule)).toBe(true);
  });

  function tightenFirstList(doc: Node): Node {
    const state = EditorState.create({ doc });
    return state.apply(state.tr.setNodeMarkup(0, undefined, { ...doc.firstChild!.attrs, tight: true })).doc;
  }

  it.each([
    ['bullet list', '- lead\n  - sub\n\n  | h |\n  | --- |'],
    ['ordered list', '- lead\n  1. sub\n\n  | h |\n  | --- |'],
    ['list ending in a quote', '- lead\n  - > sub\n\n  | h |\n  | --- |'],
  ] as const)('keeps a table after a tight nested %s out of its last paragraph', (_name, source) => {
    const doc = tightenFirstList(parseMarkdown(source));
    const saved = canonical(doc);
    expect.soft(saved).toBe(source);
    const item = parseMarkdown(saved).firstChild!.firstChild!;
    expect(item.child(1).textContent).toBe('sub');
    expect(item.lastChild!.type.name).toBe('table');
  });

  it.each([
    ['paragraph', '- text\n\n  *\n    ***'],
    ['task paragraph', '- [ ] text\n\n  -\n    ---'],
    ['rule class trailer', '- ***\n  {.rule}\n\n  -\n    ---'],
  ] as const)('ends a tight %s before a nested list that moves its rule off the marker line', (_name, source) => {
    const doc = tightenFirstList(parseMarkdown(source));
    const saved = canonical(doc);
    expect.soft(saved).toBe(source);
    // An item that starts with a blank line cannot interrupt a paragraph, so the outer list may become loose.
    expect(parseMarkdown(saved).firstChild!.firstChild!.eq(doc.firstChild!.firstChild!)).toBe(true);
  });

  it.each([
    ['three dash items', '- -\n    -', '- -\n    - '],
    ['four asterisk items', '* *\n    * *', '* *\n    * * '],
    ['three dash items in an ordered item', '1. -\n     - -', '1. -\n     - - '],
  ] as const)('keeps empty nested items from forming a rule (%s)', (_name, source, expected) => {
    const doc = parseMarkdown(source);
    expect(doc.firstChild!.type.name).not.toBe('horizontal_rule');
    const saved = canonical(doc);
    expect.soft(saved).toBe(expected);
    expect(parseMarkdown(saved).eq(doc)).toBe(true);
  });

  it.each([
    ['ordered rule chain', '1. - -\n       ---'],
    ['asterisk rule chain', '* - -\n      ---'],
    ['ordered empty chain', '1. - - '],
  ] as const)('keeps two nested dash markers on one line under another marker (%s)', (_name, source) => {
    const doc = parseMarkdown(source);
    expect(canonical(doc)).toBe(source);
    expect(parseMarkdown(canonical(doc)).eq(doc)).toBe(true);
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

  it('rewrites the legacy class-only paragraph without losing either class owner', () => {
    const source = '- a\n\n  {.x}\n{.list}';
    const expected = '- a {.x}\n\n  []{.list}';
    const doc = parseMarkdown(source);
    const list = doc.firstChild!;
    const item = list.firstChild!;
    expect(list.attrs.tight).toBe(false);
    expect(list.attrs.classes).toEqual([]);
    expect(item.attrs.classes).toEqual(['x']);
    expect(item.childCount).toBe(2);
    expect(item.child(1).attrs.classes).toEqual(['list']);
    expect(item.child(1).content.size).toBe(0);
    expect(serializeMarkdown(doc)).toBe(source);
    expect.soft(canonical(doc)).toBe(expected);
    expect.soft(parseMarkdown(canonical(doc)).eq(doc)).toBe(true);

    const edited = editText(doc, 'a', 'edited');
    const saved = serializeMarkdown(edited);
    expect.soft(saved).toBe(expected.replace('a', 'edited'));
    expect(parseMarkdown(saved).eq(edited)).toBe(true);
  });

  it.each([
    ['second paragraph', '- a {.item}\n\n  b\n  {.p}', 'b', '- a {.item}\n\n  []{.p}', false, 1],
    ['tight first paragraph', '- a {.item}\n  {.p}', 'a', '- []{.p} {.item}', true, 0],
    ['tight task paragraph', '- [x] a\n  {.p}', 'a', '- [x] []{.p}', true, 0],
    ['loose ordered task paragraph', '7) [ ] a {.item}\n\n   {.p}',
      'a', '7) [ ] []{} {.item}\n\n   {.p}', false, 0],
    ['loose nested paragraph', '> - - a\n>\n>     {.p}', 'a', '> - - []{}\n>\n>     {.p}', false, 0],
    ['paragraph beside escaped text', '- \\[\\]\\{.literal} {.item}\n\n  b\n  {.p}',
      'b', '- \\[\\]\\{.literal} {.item}\n\n  []{.p}', false, 1],
  ] as const)('keeps an emptied %s and its classes after an edit', (_name, source, text, expected, tight, index) => {
    const edited = editText(parseMarkdown(source), text, '');
    let list = edited.firstChild!;
    if (list.type.name === 'blockquote') list = list.firstChild!.firstChild!.child(1);
    const paragraph = list.firstChild!.child(index);
    expect(list.attrs.tight).toBe(tight);
    expect(paragraph.type.name).toBe('paragraph');
    expect(paragraph.attrs.classes).toEqual(['p']);
    expect(paragraph.content.size).toBe(0);

    for (const written of [serializeMarkdown(edited), canonical(edited)]) {
      expect.soft(written).toBe(expected);
      const reparsed = parseMarkdown(written);
      expect.soft(reparsed.eq(edited)).toBe(true);
      expect.soft(canonical(reparsed)).toBe(written);
    }
  });

  it('keeps the class of a list paragraph that holds only a hard break', () => {
    const { nodes } = markdownSchema;
    const paragraph = nodes.paragraph.create({ classes: ['p'] }, nodes.hard_break.create());
    const doc = nodes.doc.create(null, nodes.bullet_list.create(null, nodes.list_item.create(null, paragraph)));
    const written = canonical(doc);
    expect(written).toBe('- []{.p}');
    const item = parseMarkdown(written).firstChild!.firstChild!;
    expect(item.attrs.classes).toEqual([]);
    expect(item.firstChild!.attrs.classes).toEqual(['p']);
  });

  it.each([
    ['nested list', '[^1]: - a\n       - b', 'b'],
    ['second paragraph', '[^1]: - a\n\n       b', 'b'],
    ['paragraph class trailer', '[^1]: - a\n\n       {.x}', 'a'],
    ['later item', '[^1]: - a\n     - b\n       - c', 'c'],
    ['fence in an ordered item', '[^1]: 1. ```\n        b\n        ```', 'b'],
    ['fence', '[^1]: ```\n      b\n     ```', 'b'],
  ] as const)('keeps a %s on the first line of a footnote', (_name, source, text) => {
    const doc = parseMarkdown('ref[^1]\n\n' + source);
    const written = canonical(doc);
    expect.soft(written).toBe('ref[^1]\n\n' + source);
    expect.soft(parseMarkdown(written).eq(doc)).toBe(true);

    const edited = editText(doc, text, 'edited');
    expect(parseMarkdown(serializeMarkdown(edited)).eq(edited)).toBe(true);
  });

  it.each([
    ['quote', '> b\n  >\n  {.x}'],
    ['fence', '```\n  b\n  ```\n  {.x}'],
  ] as const)('keeps a styled %s and a following list starting above one in a tight item', (_name, block) => {
    const doc = parseMarkdown('- a\n  ' + block + '\n  1. c');
    const state = EditorState.create({ doc });
    let position = -1;
    doc.descendants((node, offset) => {
      if (node.type.name === 'ordered_list') position = offset;
    });
    const list = doc.nodeAt(position)!;
    const edited = state.apply(state.tr.setNodeMarkup(position, null, { ...list.attrs, order: 7 })).doc;
    const item = parseMarkdown(serializeMarkdown(edited)).firstChild!.firstChild!;
    expect(item.childCount).toBe(3);
    expect(item.child(1).attrs.classes).toEqual(['x']);
    expect(item.child(2).type.name).toBe('ordered_list');
    expect(item.child(2).attrs.order).toBe(7);
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
