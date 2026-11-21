// @vitest-environment node
import { EditorState } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { expect, it } from 'vitest';
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
    const classEdit = editItemClass(doc);
    if (classEdit) check('class edit', classEdit, serializeMarkdown(classEdit));
  }
  if (full) console.log(`Markdown round trips for ${checked} sources`, Object.fromEntries(counts));
  expect(checked).toBeGreaterThan(0);
  expect(failures.slice(0, 4), `${failures.length} failures across ${checked} Markdown sources`).toEqual([]);
}, 240_000);
