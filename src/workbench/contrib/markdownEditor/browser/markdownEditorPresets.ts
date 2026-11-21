import type { Mark, MarkType } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { selectedTextBlocks } from './markdownEditorBlockStyles.js';
import type { SelectedTextBlock } from './markdownEditorBlockStyles.js';

interface PresetChoice {
  readonly label: string;
  readonly value: string;
  readonly className?: string;
}

interface PresetAxis {
  readonly options: readonly PresetChoice[];
  readonly defaultValue: string;
}

export type PresetAxisId = 'textAlign' | 'fontSize' | 'fontFamily';

// Both UI and transactions use this table. Markdown persists the resulting generic classes.
export const formattingPresets: Record<PresetAxisId, PresetAxis> = {
  textAlign: {
    defaultValue: 'left',
    options: [
      { label: 'Left', value: 'left' },
      { label: 'Center', value: 'center', className: 'center' },
      { label: 'Right', value: 'right', className: 'right' },
      { label: 'Justify', value: 'justify', className: 'justify' },
    ],
  },
  fontSize: {
    defaultValue: 'default',
    options: [
      { label: 'Small', value: 'small', className: 'size-sm' },
      { label: 'Default', value: 'default' },
      { label: 'Large', value: 'large', className: 'size-lg' },
      { label: 'Extra Large', value: 'extraLarge', className: 'size-xl' },
    ],
  },
  fontFamily: {
    defaultValue: 'default',
    options: [
      { label: 'Default', value: 'default' },
      { label: 'Serif', value: 'serif', className: 'font-serif' },
      { label: 'Sans Serif', value: 'sans', className: 'font-sans' },
      { label: 'Monospace', value: 'monospace', className: 'font-mono' },
    ],
  },
};

const axisIds: readonly PresetAxisId[] = ['textAlign', 'fontSize', 'fontFamily'];

function presetForClass(axis: PresetAxisId, name: string): string | undefined {
  // Treat an explicitly authored .left as the default alignment when replacing the axis.
  if (axis === 'textAlign' && name === 'left') {
    return 'left';
  }
  return formattingPresets[axis].options.find(option => option.className === name)?.value;
}

function presetInClasses(axis: PresetAxisId, classes: readonly string[]): string | undefined {
  for (const name of classes) {
    const value = presetForClass(axis, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
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

export function setFormattingPreset(axis: PresetAxisId, value: string): Command {
  return (state, dispatch) => {
    const choice = formattingPresets[axis].options.find(option => option.value === value);
    if (!choice) {
      return false;
    }
    const { selection } = state;
    const tr = state.tr;
    const span = state.schema.marks.span;
    for (const block of selectedTextBlocks(state.doc, selection)) {
      const { node, pos, from, to } = block;
      const useBlock = axis === 'textAlign' || !node.type.allowsMarkType(span)
        || (!selection.empty && from === 0 && to === node.content.size);
      if (axis === 'textAlign' && node.type === state.schema.nodes.table_cell) {
        continue;
      }
      if (useBlock) {
        const original: readonly string[] = node.attrs.classes;
        const classes = replaceClasses(original, axis, choice.className);
        if (classes !== original) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, classes });
        }
        if (axis !== 'textAlign') {
          updateSpans(tr, { ...block, from: 0, to: node.content.size }, span, axis);
        }
      } else if (selection.empty) {
        const mark = span.isInSet(state.storedMarks ?? selection.$from.marks());
        const classes = changedSpanClasses(mark, axis, choice.className);
        if (classes) {
          tr.removeStoredMark(span);
          if (classes.length) {
            tr.addStoredMark(span.create({ classes }));
          }
        }
      } else {
        updateSpans(tr, block, span, axis, choice.className);
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
  state: EditorState, blocks: readonly SelectedTextBlock[],
): Record<PresetAxisId, string | null> {
  const { selection, schema } = state;
  const span = schema.marks.span;
  const result: Record<PresetAxisId, string | null> = { textAlign: null, fontSize: null, fontFamily: null };
  for (const axis of axisIds) {
    let common: string | null | undefined;
    const record = (value: string | null) => {
      common = common === undefined || common === value ? value : null;
    };
    for (const { node, from, to } of blocks) {
      if (axis === 'textAlign' && node.type === schema.nodes.table_cell) {
        record(null);
        continue;
      }
      const base = presetInClasses(axis, node.attrs.classes) ?? formattingPresets[axis].defaultValue;
      const effective = (mark: Mark | undefined) => presetInClasses(axis, spanClasses(mark)) ?? base;
      if (axis === 'textAlign' || !node.type.allowsMarkType(span)) {
        record(base);
      } else if (selection.empty) {
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
          record(base);
        }
      }
    }
    result[axis] = common ?? null;
  }
  return result;
}
