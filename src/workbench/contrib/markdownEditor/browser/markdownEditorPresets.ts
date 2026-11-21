import type { Mark, MarkType, Node } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import { isMarkdownTableCell } from '../../../../editor/common/markdown/schema.js';
import { defaultMarkdownFonts, markdownFontFamilies, markdownFontSizes } from '../common/markdownEditor.js';
import type { MarkdownFontDefaults } from '../common/markdownEditor.js';
import { selectedTextBlocks } from './markdownEditorBlockStyles.js';
import type { SelectedTextBlock } from './markdownEditorBlockStyles.js';

interface PresetChoice {
  readonly label: string;
  readonly value: string;
  readonly className?: string;
  readonly legacyClassName?: string;
  readonly readOnly?: boolean;
  readonly hidden?: boolean;
}

interface PresetAxis {
  readonly options: readonly PresetChoice[];
}

export type PresetAxisId = 'textAlign' | 'fontSize' | 'fontFamily';

const headingScales = [2, 1.5, 1.17, 1, 0.83, 0.67];
const subtitleScale = 1.25;
const legacySizeScales = new Map([['small', 0.875], ['large', 1.25], ['extraLarge', 1.5]]);

// Both UI and transactions use this table. Markdown persists the resulting generic classes.
// Within an axis the options follow the order of their equal-specificity rules in markdownTheme.css, so when a
// block carries several classes of one axis the last listed option is the one that renders.
export const formattingPresets: Record<PresetAxisId, PresetAxis> = {
  textAlign: {
    options: [
      { label: 'Left', value: 'left', className: 'left' },
      { label: 'Center', value: 'center', className: 'center' },
      { label: 'Right', value: 'right', className: 'right' },
      { label: 'Justify', value: 'justify', className: 'justify', readOnly: true },
    ],
  },
  fontSize: {
    options: [
      { label: 'Small', value: 'small', className: 'size-sm', hidden: true },
      { label: 'Large', value: 'large', className: 'size-lg', hidden: true },
      { label: 'Extra Large', value: 'extraLarge', className: 'size-xl', hidden: true },
      ...markdownFontSizes.map(size => ({ label: `${size} pt`, value: `${size}pt`, className: `size-${size}pt` })),
    ],
  },
  fontFamily: {
    options: [
      { label: 'Serif', value: 'serif', className: 'font-serif', hidden: true },
      { label: 'Sans Serif', value: 'sans', className: 'font-sans', hidden: true },
      ...markdownFontFamilies.map(option => ({
        ...option, className: `font-${option.value}`,
        legacyClassName: option.value === 'monospace' ? 'font-mono' : undefined,
      })),
    ],
  },
};

const axisIds: readonly PresetAxisId[] = ['textAlign', 'fontSize', 'fontFamily'];

function presetForClass(axis: PresetAxisId, name: string): string | undefined {
  return formattingPresets[axis].options.find(option => option.className === name || option.legacyClassName === name)?.value;
}

function presetInClasses(axis: PresetAxisId, classes: readonly string[]): string | undefined {
  // The table follows the CSS rule order, so the last present option is the rendered one, whatever the authored order.
  let effective: string | undefined;
  for (const { className, legacyClassName, value } of formattingPresets[axis].options) {
    if ((className && classes.includes(className)) || (legacyClassName && classes.includes(legacyClassName))) {
      effective = value;
    }
  }
  return effective;
}

interface FontSize {
  readonly points: number;
  readonly legacy?: string;
}

interface BlockPresets {
  readonly textAlign: string;
  readonly fontSize: FontSize;
  readonly fontFamily: string;
}

function scalePoints(points: number, scale: number): number {
  return Number((points * scale).toFixed(8));
}

function sizeWithPreset(base: FontSize, preset: string | undefined): FontSize {
  if (preset === undefined) return base;
  const scale = legacySizeScales.get(preset);
  return scale === undefined
    ? { points: Number.parseInt(preset, 10) }
    : { points: scalePoints(base.points, scale), legacy: preset };
}

function sizeValue(size: FontSize): string {
  return size.legacy ?? `${size.points}pt`;
}

export function markdownFontSizeLabel(value: string): string {
  return legacySizeScales.has(value) ? 'Custom' : `${Number(Number.parseFloat(value).toFixed(2))} pt`;
}

function withClasses(base: BlockPresets, classes: readonly string[]): BlockPresets {
  return {
    textAlign: presetInClasses('textAlign', classes) ?? base.textAlign,
    fontSize: sizeWithPreset(base.fontSize, presetInClasses('fontSize', classes)),
    fontFamily: presetInClasses('fontFamily', classes) ?? base.fontFamily,
  };
}

/** Effective defaults before each text block's own preset classes are applied. */
function inheritedBlockPresets(
  doc: Node, blocks: readonly SelectedTextBlock[], defaults: MarkdownFontDefaults,
): Map<number, BlockPresets> {
  const inherited = new Map<number, BlockPresets>();
  if (!blocks.length) return inherited;
  let from = blocks[0].pos;
  let to = from;
  for (const { pos } of blocks) {
    from = Math.min(from, pos);
    to = Math.max(to, pos);
  }
  const wanted = new Set(blocks.map(({ pos }) => pos));
  const root: BlockPresets = { textAlign: 'left', fontSize: { points: defaults.size }, fontFamily: defaults.family };
  // One walk keeps the ancestors' styles on a stack. Resolving each block would rescan its siblings,
  // which makes a selection over a long document quadratic.
  const containers: { readonly end: number; readonly presets: BlockPresets }[] = [];
  doc.nodesBetween(from, to + 1, (node, pos) => {
    while (containers.length && containers[containers.length - 1].end <= pos) containers.pop();
    const parent = containers.at(-1)?.presets ?? root;
    const classes: readonly string[] = node.attrs.classes ?? [];
    if (node.isTextblock) {
      if (wanted.has(pos)) {
        const scale = node.type.name === 'heading' ? headingScales[node.attrs.level - 1]
          : node.type.name === 'paragraph' && classes.includes('subtitle') ? subtitleScale : undefined;
        inherited.set(pos, {
          textAlign: parent.textAlign,
          fontSize: scale === undefined ? parent.fontSize : { points: scalePoints(parent.fontSize.points, scale) },
          fontFamily: node.type.spec.code ? 'monospace' : parent.fontFamily,
        });
      }
      return false;
    }
    containers.push({ end: pos + node.nodeSize, presets: classes.length ? withClasses(parent, classes) : parent });
    return true;
  });
  return inherited;
}

function presetClassFor(
  axis: PresetAxisId, choice: PresetChoice, fallback: BlockPresets,
): string | undefined {
  const inherited = axis === 'fontSize' ? `${fallback.fontSize.points}pt` : fallback[axis];
  return choice.value === inherited ? undefined : choice.className;
}

function replaceClasses(
  classes: readonly string[], axis: PresetAxisId, className: string | undefined,
): readonly string[] {
  const rest = classes.filter(name => presetForClass(axis, name) === undefined);
  if (classes.length === rest.length + (className === undefined ? 0 : 1) &&
      (className === undefined || classes.includes(className))) {
    return classes;
  }
  return className === undefined ? rest : [...rest, className];
}

function spanClasses(mark: Mark | undefined): readonly string[] {
  return mark?.attrs.classes ?? [];
}

function changedSpanClasses(
  mark: Mark | undefined, axis: PresetAxisId, className?: string,
): readonly string[] | undefined {
  const original = spanClasses(mark);
  const classes = replaceClasses(original, axis, className);
  return classes === original ? undefined : classes;
}

function updateSpans(
  tr: Transaction, block: SelectedTextBlock, span: MarkType, axis: PresetAxisId, className?: string,
): void {
  block.node.forEach((child, offset) => {
    const from = Math.max(offset, block.from) + block.pos + 1;
    const to = Math.min(offset + child.nodeSize, block.to) + block.pos + 1;
    if (!child.isText || from >= to) {
      return;
    }
    const mark = span.isInSet(child.marks);
    const classes = changedSpanClasses(mark, axis, className);
    if (!classes) {
      return;
    }
    if (mark) {
      tr.removeMark(from, to, mark);
    }
    if (classes.length) {
      tr.addMark(from, to, span.create({ classes }));
    }
  });
}

export function setFormattingPreset(
  axis: PresetAxisId, value: string, defaults = defaultMarkdownFonts,
): Command {
  return (state, dispatch) => {
    const choice = formattingPresets[axis].options.find(option => option.value === value);
    if (!choice || choice.readOnly) {
      return false;
    }
    const { selection } = state;
    const caret = selection.empty && !(selection instanceof CellSelection);
    const tr = state.tr;
    const span = state.schema.marks.span;
    const blocks = selectedTextBlocks(state.doc, selection);
    const inherited = inheritedBlockPresets(state.doc, blocks, defaults);
    for (const block of blocks) {
      const { node, pos, from, to } = block;
      const useBlock = axis === 'textAlign' || !node.type.allowsMarkType(span)
        || (!caret && from === 0 && to === node.content.size);
      if (axis === 'textAlign' && isMarkdownTableCell(node)) {
        continue;
      }
      const original: readonly string[] = node.attrs.classes;
      const fallback = inherited.get(pos)!;
      const className = presetClassFor(axis, choice, useBlock ? fallback : withClasses(fallback, original));
      if (useBlock) {
        const classes = replaceClasses(original, axis, className);
        if (classes !== original) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, classes });
        }
        if (axis !== 'textAlign') {
          updateSpans(tr, { ...block, from: 0, to: node.content.size }, span, axis);
        }
      } else if (caret) {
        const mark = span.isInSet(state.storedMarks ?? selection.$from.marks());
        const classes = changedSpanClasses(mark, axis, className);
        if (classes) {
          tr.removeStoredMark(span);
          if (classes.length) {
            tr.addStoredMark(span.create({ classes }));
          }
        }
      } else {
        updateSpans(tr, block, span, axis, className);
      }
    }
    if (!tr.docChanged && !tr.storedMarksSet) {
      return false;
    }
    dispatch?.(tr);
    return true;
  };
}

export function currentFormattingPresets(
  state: EditorState, blocks: readonly SelectedTextBlock[], defaults = defaultMarkdownFonts,
): Record<PresetAxisId, string | null> {
  const { selection, schema } = state;
  const span = schema.marks.span;
  const result: Record<PresetAxisId, string | null> = { textAlign: null, fontSize: null, fontFamily: null };
  const inherited = inheritedBlockPresets(state.doc, blocks, defaults);
  const bases = blocks.map(({ node, pos }) => withClasses(inherited.get(pos)!, node.attrs.classes));
  const caret = selection.empty && !(selection instanceof CellSelection);
  for (const axis of axisIds) {
    let common: string | null | undefined;
    const record = (value: string | null) => {
      common = common === undefined || common === value ? value : null;
    };
    for (const [index, { node, from, to }] of blocks.entries()) {
      const base = bases[index];
      if (axis === 'textAlign') {
        record(isMarkdownTableCell(node) ? null : base.textAlign);
        continue;
      }
      const effective = (mark?: Mark) => {
        const preset = presetInClasses(axis, spanClasses(mark));
        return axis === 'fontSize' ? sizeValue(sizeWithPreset(base.fontSize, preset)) : preset ?? base.fontFamily;
      };
      if (!node.type.allowsMarkType(span)) {
        record(effective());
      } else if (caret) {
        record(effective(span.isInSet(state.storedMarks ?? selection.$from.marks())));
      } else {
        let textFound = false;
        node.forEach((child, offset) => {
          if (child.isText && from < offset + child.nodeSize && to > offset) {
            textFound = true;
            record(effective(span.isInSet(child.marks)));
          }
        });
        if (!textFound) {
          record(effective());
        }
      }
    }
    result[axis] = common ?? null;
  }
  return result;
}
