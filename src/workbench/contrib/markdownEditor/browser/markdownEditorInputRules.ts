import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import type { MarkType } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { markdownSchema } from '../../../../editor/common/markdown/schema.js';

const { nodes, marks } = markdownSchema;

function markRule(expression: RegExp, type: MarkType): InputRule {
  return new InputRule(expression, (state, match, start, end) => {
    const from = start + match[1].length;
    if (!state.doc.resolve(from).parent.type.allowsMarkType(type)) return null;
    // Only the marker characters are removed, so links, images and breaks inside the span stay.
    const marker = match[2].length;
    const contentEnd = end - (marker - 1);
    const tr = state.tr.delete(contentEnd, end).delete(from, from + marker);
    return tr.addMark(from, contentEnd - marker, type.create({ markup: match[2] })).removeStoredMark(type);
  }, { inCodeMark: false });
}

const task = new InputRule(/^\[([ xX])\] $/, (state, match, start, end) => {
  const $start = state.doc.resolve(start);
  if ($start.parent.type !== nodes.paragraph) return null;
  const checked = match[1] !== ' ';
  const tr = state.tr.delete(start, end);
  const parent = $start.node(-1);
  if ((parent.type === nodes.list_item || parent.type === nodes.task_item) && $start.index(-1) === 0) {
    return tr.setNodeMarkup($start.before(-1), nodes.task_item, { ...parent.attrs, checked });
  }
  if (!parent.canReplaceWith($start.index(-1), $start.indexAfter(-1), nodes.bullet_list)) return null;
  const range = tr.doc.resolve(start).blockRange();
  return range ? tr.wrap(range, [{ type: nodes.bullet_list }, { type: nodes.task_item, attrs: { checked } }]) : null;
});

const horizontalRule = new InputRule(/^---$/, (state, _match, start, end) => {
  const $start = state.doc.resolve(start);
  const index = $start.index(-1);
  if ($start.parent.type !== nodes.paragraph || end !== $start.end()
      || !$start.node(-1).canReplaceWith(index, index, nodes.horizontal_rule)) return null;
  const position = $start.before();
  const rule = nodes.horizontal_rule.create({ markup: '---' });
  const tr = state.tr.delete(start, end).insert(position, rule);
  return tr.setSelection(TextSelection.create(tr.doc, position + rule.nodeSize + 1));
});

export const markdownInputRules = inputRules({ rules: [
  textblockTypeInputRule(/^(#{1,6}) $/, nodes.heading, match => ({ level: match[1].length })),
  wrappingInputRule(/^([-*]) $/, nodes.bullet_list, match => ({ bullet: match[1] }), (match, node) => match[1] === node.attrs.bullet),
  wrappingInputRule(/^(\d{1,9})\. $/, nodes.ordered_list, match => ({ order: Number(match[1]), markup: '.' }),
    (match, node) => Number(match[1]) === node.attrs.order + node.childCount),
  wrappingInputRule(/^> $/, nodes.blockquote),
  task,
  textblockTypeInputRule(new RegExp('^`{3}$'), nodes.code_block, { markup: '```' }),
  horizontalRule,
  markRule(/(^|[^*\\])(\*\*)([^*\s](?:[^*\n]*?[^*\s])?)\*\*$/, marks.strong),
  markRule(/(^|[^*\\])(\*)([^*\s](?:[^*\n]*?[^*\s])?)\*$/, marks.em),
  markRule(/(^|[^~\\])(~~)([^~\s](?:[^~\n]*?[^~\s])?)~~$/, marks.strike),
  markRule(new RegExp('(^|[^`\\\\])(`)([^`\\n]+)`$'), marks.code),
] });
