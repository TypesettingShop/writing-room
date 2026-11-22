// @vitest-environment node
import { EditorState } from 'prosemirror-state';
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { expect, it } from 'vitest';
import { createMarkdownIt } from '../../../common/markdown/markdownIt.js';
import { parseMarkdown } from '../../../common/markdown/parser.js';
import { serializeMarkdown } from '../../../common/markdown/serializer.js';

const markers = ['- ', '* ', '+ ', '1. ', '9) ', '- [ ] '];
const rules = ['---', '***', '___', '- - -', '* * *', '_ _ _'];
const lists = ['- m', '* m', '+ m', '1. m', '3) m', '10. m', '- [x] m'];
const table = '| h |\n{I}| --- |\n{I}| b |';
const fence = '```\n{I}c\n{I}```';
const firstBlocks = [
  'a', '', 'a\n{I}{.x}', '# h', '<div>x</div>', '***\n{I}{.x}', '> q\n{I}>\n{I}{.x}', fence, '> q', table,
  ...rules, ...rules.map(rule => '\n{I}' + rule),
  ...lists, ...lists.map(list => '\n{I}' + list),
];
const nextBlocks = [
  null, 'b', '# h2', 's\n{I}===', 's\n{I}---', ...rules, table, fence, '> r', ...lists, '{.y}', '<div>x</div>',
];

function wrap(source: string, first: string, continuation: string): string {
  return source.split('\n').map((line, index) =>
    index === 0 ? first + line : line ? continuation + line : continuation.trimEnd(),
  ).join('\n');
}

function combinations(): Set<string> {
  const sources = new Set<string>();
  for (const marker of markers) {
    const indent = ' '.repeat(marker === '- [ ] ' ? 2 : marker.length);
    for (const first of firstBlocks) {
      for (const next of nextBlocks) {
        for (const gap of next === null ? ['\n'] : ['\n', '\n\n']) {
          const item = marker + first.replaceAll('{I}', indent) +
            (next === null ? '' : gap + indent + next.replaceAll('{I}', indent));
          for (const sibling of ['', '\n' + marker + 'tail', '\n\n' + marker + 'tail']) {
            const source = item + sibling;
            const nested = wrap(source, '- ', '  ');
            sources.add(source);
            sources.add(nested);
            sources.add(wrap(source, '1. ', '   '));
            sources.add(wrap(source, '> ', '> '));
            sources.add(wrap(nested, '* ', '  '));
            sources.add(source + '\n\n[^1]: f');
          }
        }
      }
    }
  }
  return sources;
}

function inDefaultSample(source: string): boolean {
  // Fixed FNV-1a sample. Hash the source so ordering changes do not change the sample.
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 16777619);
  }
  return (hash >>> 0) % 128 === 0;
}

const quoteBeforeSetext = '- > q\n  >\n  {.x}\n  s\n  ===';
const indentationRegressions = new Map([
  ['- Parent\n  - [x] Child\n    - Grandchild', '- Parent\n    - [x] Child\n        - Grandchild'],
  [
    '- Parent\n\n  second paragraph\n\n  - Child\n\n        let x = 1;',
    '- Parent\n\n  second paragraph\n\n    - Child\n\n      ```\n      let x = 1;\n      ```',
  ],
  [
    '100. Parent\n\n     second paragraph\n\n     - Child\n\n       ~~~text\n         indented\n       ~~~',
    '100. Parent\n\n     second paragraph\n\n     - Child\n\n       ~~~text\n         indented\n       ~~~',
  ],
  ['* - - \n\n       3) m', '* - - \n    3) m'],
  // A marker wider than four columns keeps its own width.
  ['100. Parent\n     - Child\n       1. Grandchild', '100. Parent\n     - Child\n         1. Grandchild'],
]);
const regressions = new Set([
  '- a\n  s\n  ===', // wr-x9d4
  '> * ***\n>   {.x}\n>   {.y}', // wr-vcbs
  '- - ---\n    b', // Indented code is rewritten as a fence.
  '- ***\n  {.x}\n  {.y}', // A class edit forces a loose list.
  quoteBeforeSetext,
  '- \\+\n  s\n  ===', // wr-x9d4: a literal marker on the first Setext line.
  ...indentationRegressions.keys(),
]);

function editFirstText(doc: Node): Node | undefined {
  let position: number | undefined;
  doc.descendants((node, offset) => {
    if (position === undefined && node.isText) position = offset + node.text!.length;
    return position === undefined;
  });
  if (position === undefined) return;
  const state = EditorState.create({ doc });
  return state.apply(state.tr.insertText('Z', position)).doc;
}

function editItemClass(doc: Node): Node | undefined {
  let position: number | undefined;
  doc.descendants((node, offset) => {
    if (position !== undefined) return false;
    if (node.type.name !== 'list_item' && node.type.name !== 'task_item') return true;
    node.forEach((child, childOffset) => {
      if ('classes' in child.attrs && !child.type.name.endsWith('_list') &&
        !(child.type.name === 'paragraph' && !child.content.size)) position = offset + 1 + childOffset;
    });
    return false;
  });
  if (position === undefined) return;
  const state = EditorState.create({ doc });
  const node = doc.nodeAt(position)!;
  return state.apply(state.tr.setNodeMarkup(position, undefined, { ...node.attrs, classes: ['k'] })).doc;
}

function canonical(doc: Node): string {
  return serializeMarkdown(doc, { preserveSource: false });
}

type Normalization = 'indented code fence' | 'looser list at a class boundary';

function hasClassBoundary(list: Node): boolean {
  if (list.type.name !== 'bullet_list' && list.type.name !== 'ordered_list') return false;
  for (let itemIndex = 0; itemIndex < list.childCount; itemIndex++) {
    const item = list.child(itemIndex);
    for (let index = 0; index < item.childCount; index++) {
      const block = item.child(index);
      // These blocks emit a separate class line, which can otherwise join the next block.
      if (!block.attrs.classes?.length || !['blockquote', 'code_block', 'horizontal_rule', 'table',
        'bullet_list', 'ordered_list'].includes(block.type.name)) continue;
      if (block.type.name === 'table') return true;
      const next = item.maybeChild(index + 1);
      if (next?.type.name === 'paragraph' ||
        (next?.type.name === 'ordered_list' && next.attrs.order !== 1)) return true;
    }
  }
  return false;
}

function equivalent(expected: Node, actual: Node, normalizations: Set<Normalization>): boolean {
  if (expected.eq(actual)) return true;
  if (expected.type !== actual.type || expected.childCount !== actual.childCount || expected.text !== actual.text) {
    return false;
  }
  const attrs = { ...expected.attrs };
  if (expected.type.name === 'code_block' && attrs.markup === null && /^`{3,}$/.test(actual.attrs.markup ?? '')) {
    attrs.markup = actual.attrs.markup;
    normalizations.add('indented code fence');
  }
  if (attrs.tight === true && actual.attrs.tight === false && hasClassBoundary(expected)) {
    attrs.tight = false;
    normalizations.add('looser list at a class boundary');
  }
  if (!actual.hasMarkup(expected.type, attrs, expected.marks)) return false;
  for (let index = 0; index < expected.childCount; index++) {
    if (!equivalent(expected.child(index), actual.child(index), normalizations)) return false;
  }
  return true;
}

it('preserves document content through generated Markdown saves', () => {
  const full = process.env.MARKDOWN_ROUNDTRIP_FULL === '1';
  let checked = 0;
  const failures: unknown[] = [];
  const counts = new Map<string, number>();
  const count = (kind: string) => counts.set(kind, (counts.get(kind) ?? 0) + 1);
  // Check the regressions even if the generator stops producing them.
  for (const source of new Set([...combinations(), ...regressions])) {
    if (!full && !regressions.has(source) && !inDefaultSample(source)) continue;
    checked++;
    const doc = parseMarkdown(source);
    doc.check();
    const check = (save: string, target: Node, written: string) => {
      count(save);
      const actual = parseMarkdown(written);
      actual.check();
      const normalizations = new Set<Normalization>();
      if (!equivalent(target, actual, normalizations)) {
        failures.push({ save, source, written, expected: target.toJSON(), actual: actual.toJSON() });
        return;
      }
      for (const kind of normalizations) count(save + ': ' + kind);

      const repeated = canonical(actual);
      if (repeated === written) return;
      if (save === 'canonical' && !normalizations.has('looser list at a class boundary')) {
        failures.push({ save, source, written, repeated, reason: 'canonical output changed' });
        return;
      }
      const reopened = parseMarkdown(repeated);
      reopened.check();
      const rewriteNormalizations = new Set<Normalization>();
      if (!equivalent(actual, reopened, rewriteNormalizations) || canonical(reopened) !== repeated) {
        failures.push({ save, source, written, repeated, reason: 'did not reach a stable canonical save',
          expected: actual.toJSON(), actual: reopened.toJSON(), next: canonical(reopened) });
      } else {
        for (const kind of rewriteNormalizations) count(save + ' canonical rewrite: ' + kind);
      }
    };
    if (serializeMarkdown(doc) !== source) failures.push({ save: 'unedited', source });
    const normalized = canonical(doc);
    if (source === quoteBeforeSetext) {
      expect(normalized).toBe('- > q\n  >\n  \\{.x}\n  s\n  ===');
    }
    const indentation = indentationRegressions.get(source);
    if (indentation !== undefined) expect(normalized).toBe(indentation);
    check('canonical', doc, normalized);
    const textEdit = editFirstText(doc);
    if (textEdit) check('text edit', textEdit, serializeMarkdown(textEdit));
    // A new block changes the block count, so the edited block keeps its range by attrs alone.
    const added = textEdit && textEdit.copy(textEdit.content.addToEnd(
      textEdit.type.schema.nodes.paragraph.create(null, textEdit.type.schema.text('added'))));
    if (added) check('text edit and new block', added, serializeMarkdown(added));
    const classEdit = editItemClass(doc);
    if (classEdit) check('class edit', classEdit, serializeMarkdown(classEdit));
  }
  if (full) console.log(`Markdown round trips for ${checked} sources`, Object.fromEntries(counts));
  expect(checked).toBeGreaterThan(0);
  expect(failures.slice(0, 4), `${failures.length} failures across ${checked} Markdown sources`).toEqual([]);
}, 240_000);

it('keeps generated separators with their original neighbors across edits to duplicate paragraphs', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const padding of ['', ' ', '\t']) {
      const fresh = eol + eol;
      const gaps = [eol.repeat(3), eol + padding + fresh, eol.repeat(4), eol + ' \t' + fresh];
      const original = ['start', 'dup', 'anchor', 'd&#117;p', 'end'];
      const source = original.map((text, index) => text + (gaps[index] ?? eol)).join('');
      const doc = parseMarkdown(source);
      expect(doc.child(1).eq(doc.child(3))).toBe(true);
      const state = EditorState.create({ doc });
      const position = 1 + doc.child(0).nodeSize + doc.child(1).nodeSize + doc.child(2).nodeSize;
      const edited = state.apply(state.tr.insertText('changed', position, position + 3)).doc;
      const added = doc.type.schema.nodes.paragraph.create(null, doc.type.schema.text('added'));
      const cases = [
        [[5, 0, 1, 2, 3, 4], [fresh, ...gaps]],
        [[0, 1, 2, 5, 3, 4], [gaps[0], gaps[1], fresh, fresh, gaps[3]]],
        [[0, 2, 3, 4, 5], [fresh, gaps[2], gaps[3], fresh]],
        [[0, 1, 3, 4], [gaps[0], fresh, gaps[3]]],
        [[0, 3, 1, 2, 4], [fresh, fresh, gaps[1], fresh]],
        [[0, 1, 2, 3, 4, 3], [gaps[0], gaps[1], fresh, fresh, fresh]],
      ] as const;
      const blocks = [...edited.content.content, added];
      const texts = [...original.slice(0, 3), 'changed', 'end', 'added'];
      for (const [order, separators] of cases) {
        const target = edited.copy(Fragment.fromArray(order.map(index => blocks[index])));
        const expected = order.map((index, offset) => texts[index] + (separators[offset] ?? eol)).join('');
        const saved = serializeMarkdown(target);
        expect(saved, JSON.stringify({ eol, padding, order })).toBe(expected);
        expect(parseMarkdown(saved).eq(target), saved).toBe(true);
      }
    }
  }
});

it('keeps generated indented code blocks outside containers after a move', () => {
  const containers = ['- item', '1. item', '[^note]: definition'];
  const codeSources = [
    ['    code\n    ```\n      tail', '````\ncode\n```\n  tail\n````'],
    ['\tcode\n\ttail', '```\ncode\ntail\n```'],
    ['  ~~~text\n  code\n  ~~~', '~~~text\ncode\n~~~'],
    ['~~~ text\ncode\n~~~', '~~~ text\ncode\n~~~'],
  ];
  for (const eol of ['\n', '\r\n', '\r']) {
    const gap = eol + ' \t' + eol + eol;
    const fresh = eol + eol;
    for (const container of containers) {
      for (const [raw, fenced] of codeSources) {
        const code = raw.replaceAll('\n', eol);
        const source = [container, 'anchor', code, 'end'].join(gap) + eol;
        const doc = parseMarkdown(source);
        expect(doc.child(2).type.name, source).toBe('code_block');
        const state = EditorState.create({ doc });
        const edited = state.apply(state.tr.insertText('!', doc.content.size - 1)).doc;
        expect(serializeMarkdown(edited), source).toBe(source.replace('end', 'end!'));

        const codeBlock = edited.child(2);
        const tail = [edited.child(1), edited.child(3)];
        const empty = doc.type.schema.nodes.paragraph.create();
        const moved = edited.copy(Fragment.fromArray([edited.child(0), empty, codeBlock, ...tail]));
        const saved = serializeMarkdown(moved);
        expect.soft(saved, source).toBe([container, fenced.replaceAll('\n', eol), 'anchor', 'end!'].join(fresh) + eol);
        const target = edited.copy(Fragment.fromArray([edited.child(0), codeBlock, ...tail]));
        expect.soft(equivalent(target, parseMarkdown(saved), new Set()), saved).toBe(true);
      }
    }
  }
});

it('round trips underline applied to generated selections across paragraphs, emphasis and links', () => {
  const fragments = ['글', '**굵게**', '[**링크**](/x)', '`코드`'];
  for (const first of fragments) {
    for (const last of fragments) {
      const source = `앞 ${first}\n\n${last} 뒤`;
      const doc = parseMarkdown(source);
      const from = 3;
      const to = doc.content.size - 3;
      const state = EditorState.create({ doc });
      const underline = state.schema.marks.span.create({ classes: ['underline', 'keep'] });
      const edited = state.tr.addMark(from, to, underline).doc;
      const written = serializeMarkdown(edited);
      expect(written.match(/\.underline(?= )/g)?.length, source).toBe(2);
      // The class syntax alone also saved before underline existed; the `u` element is what this format adds.
      expect(createMarkdownIt().render(written).match(/<u class="underline keep">/g)?.length, written).toBe(2);
      const reopened = parseMarkdown(written);
      expect(reopened.toJSON(), written).toEqual(edited.toJSON());
      expect(canonical(reopened), written).toBe(written);
    }
  }
});
