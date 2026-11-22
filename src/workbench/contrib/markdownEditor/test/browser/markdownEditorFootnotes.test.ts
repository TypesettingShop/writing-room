// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { serializeMarkdown } from '../../../../../editor/common/markdown/serializer.js';
import { collectFootnotes, MarkdownFootnotesPanel } from '../../browser/markdownEditorFootnotes.js';

it('collects distinct labels by reference order, followed by unreferenced definitions', () => {
  const source = 'Intro[^b] ^[an *inline* note]\n\n- In a list[^a] [^b] [^missing]\n\n'
    + '[^a]: First\n\n[^b]: **Second**\n    line\n\n    paragraph\n\n[^extra]: Unused';
  const doc = parseMarkdown(source);
  const notes = collectFootnotes(doc);
  expect(notes.map(({ label, text, status }) => [label, text, status])).toEqual([
    ['b', 'Second line paragraph', undefined], [null, 'an inline note', undefined], ['a', 'First', undefined],
    ['missing', '', 'missing'], ['extra', 'Unused', 'unused'],
  ]);
  for (const note of notes) {
    if (note.definitionPos !== undefined) expect(doc.nodeAt(note.definitionPos)?.attrs.label).toBe(note.label);
    if (note.referencePos !== undefined) expect(doc.nodeAt(note.referencePos)?.attrs.label).toBe(note.label);
  }
  expect(serializeMarkdown(doc)).toBe(source);
  expect(parseMarkdown(serializeMarkdown(doc, { preserveSource: false })).toJSON()).toEqual(doc.toJSON());
});

it('ignores escaped brackets, code and links with footnote-like labels', () => {
  const doc = parseMarkdown('\\[^escaped] `[^code]` [^link](/target) ![alt [^literal]](/picture)');
  expect(collectFootnotes(doc)).toEqual([]);
  expect(doc.firstChild?.lastChild?.attrs.alt).toBe('alt [^literal]');
});

it('waits for a 200ms pause, then updates only the current tab', () => {
  vi.useFakeTimers();
  const frame = document.createElement('div');
  const panel = new MarkdownFootnotesPanel(frame, () => {}, () => {});
  const visibleText = () => frame.querySelector('li')?.textContent;
  const doc = (text: string) => parseMarkdown('Ref[^n]\n\n[^n]: ' + text);
  try {
    panel.setEnabled(true);
    panel.setDocument(doc('first'), true);
    expect(visibleText()).toBe('[n]first');
    panel.setDocument(doc('second'));
    vi.advanceTimersByTime(199);
    expect(visibleText()).toBe('[n]first');
    panel.setDocument(doc('third'));
    vi.advanceTimersByTime(199);
    expect(visibleText()).toBe('[n]first');
    vi.advanceTimersByTime(1);
    expect(visibleText()).toBe('[n]third');
    panel.setDocument(doc('pending'));
    panel.setDocument(doc('another tab'), true);
    expect(visibleText()).toBe('[n]another tab');
    vi.advanceTimersByTime(200);
    expect(visibleText()).toBe('[n]another tab');
  } finally {
    panel.dispose();
    vi.useRealTimers();
  }
});
