import { history, redo, undo, undoDepth } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import { parseMarkdown } from '../../../../../editor/common/markdown/parser.js';
import { flushMarkdownComposition, MarkdownCompositionRecovery } from '../../browser/markdownCompositionRecovery.js';

describe('Markdown IME reset recovery', () => {
  let host: HTMLDivElement;
  let button: HTMLButtonElement;
  let view: EditorView;
  let recovery: MarkdownCompositionRecovery;
  let binding: IDisposable;
  let received: Transaction[];
  let now: number;

  beforeEach(() => {
    now = 1_000;
    // jsdom stamps event.timeStamp from Date.now; history groups by it too.
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    host = document.createElement('div');
    button = document.createElement('button');
    document.body.append(host, button);
    const doc = parseMarkdown('**안녕하세**\n\n다음 문단');
    recovery = new MarkdownCompositionRecovery();
    received = [];
    view = new EditorView(host, {
      state: EditorState.create({
        doc,
        selection: TextSelection.create(doc, doc.firstChild!.nodeSize - 1),
        plugins: [history()],
      }),
      handleDOMEvents: recovery.handleDOMEvents,
      handleScrollToSelection: () => true,
      dispatchTransaction: transaction => {
        received.push(transaction);
        recovery.observeTransaction(transaction);
        view.updateState(view.state.apply(transaction));
      },
    });
    view.dom.style.whiteSpace = 'pre-wrap';
    binding = recovery.bind(view);
    view.focus();
  });

  afterEach(() => {
    binding.dispose();
    view.destroy();
    host.remove();
    button.remove();
    vi.restoreAllMocks();
  });

  function compositionEvent(type: string, data: string): void {
    view.dom.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
  }

  function update(data: string, precedingText = '안녕하세', inputData: string | null = data): void {
    compositionEvent('compositionupdate', data);
    const event = { bubbles: true, isComposing: true, inputType: 'insertCompositionText', data: inputData };
    view.dom.dispatchEvent(new InputEvent('beforeinput', event));
    const text = view.dom.querySelector('p strong')!.firstChild as Text;
    text.data = precedingText + data;
    document.getSelection()!.collapse(text, text.length);
    view.dom.dispatchEvent(new InputEvent('input', event));
  }

  function reset(endData = '', inputData: string | null = ''): void {
    compositionEvent('compositionstart', '');
    update('요');
    flushMarkdownComposition(view);
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
    now += 1_000; // The reset and recovery still belong to this composition's undo event.
    update('', '안녕하세', inputData);
    compositionEvent('compositionend', endData);
  }

  function pressOutside(type: 'pointerdown' | 'mousedown' = 'pointerdown'): void {
    button.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  }

  it('recovers a queued deletion before pointer selection, with marks and a single undo event', () => {
    reset();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
    pressOutside();
    pressOutside('mousedown');
    expect(view.dom.querySelector('p strong')!.textContent).toBe('안녕하세요');
    const writes = received.filter(transaction => transaction.docChanged);
    expect(writes.map(transaction => transaction.doc.firstChild!.textContent))
      .toEqual(['안녕하세요', '안녕하세', '안녕하세요']);
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view.state, view.dispatch)).toBe(true);
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
    expect(redo(view.state, view.dispatch)).toBe(true);
    expect(view.dom.querySelector('p strong')!.textContent).toBe('안녕하세요');
  });

  it('restores at the original deletion after the selection has already moved', () => {
    reset('요', null);
    flushMarkdownComposition(view);
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
    const secondParagraph = view.state.doc.firstChild!.nodeSize + 1;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, secondParagraph)));
    pressOutside('mousedown');
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
    expect(view.state.selection.$head.parent.textContent).toBe('다음 문단');
    expect(view.state.selection.$head.parentOffset).toBe(0);
  });

  it('reads the last preedit before a reset in the same task', () => {
    compositionEvent('compositionstart', '');
    update('요');
    update('');
    compositionEvent('compositionend', '');
    pressOutside();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
  });

  it.each(['blur', 'focusout', 'window blur', 'visibilitychange'])('recovers if %s follows the reset', event => {
    reset();
    if (event === 'window blur') {
      window.dispatchEvent(new FocusEvent('blur'));
    } else if (event === 'visibilitychange') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    } else {
      view.dom.dispatchEvent(new FocusEvent(event));
    }
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
  });

  it('keeps a user-cleared composition empty when no focus or pointer event follows the reset', async () => {
    reset();
    await Promise.resolve();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
    now += 51;
    pressOutside();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
  });

  it('tracks whether a deferred native edit kept its text through compositionend', () => {
    compositionEvent('compositionstart', '');
    update('요');
    const pending = recovery.deferredInput;
    compositionEvent('compositionend', '요');
    expect(recovery.deferredInput).toBe(pending);
    expect(pending).toMatchObject({ text: '요', lastInputWasEmpty: false });

    compositionEvent('compositionstart', '');
    update('요', '안녕하세요');
    const canceled = recovery.deferredInput;
    update('', '안녕하세요', null);
    compositionEvent('compositionend', '');
    expect(canceled).not.toBe(pending);
    expect(canceled).toMatchObject({ text: '요', lastInputWasEmpty: true });
  });

  it.each([-1, 1])('recovers a pointer stamped %d ms from the reset even when dispatch is delayed', offset => {
    vi.spyOn(window.performance, 'now').mockImplementation(() => now);
    reset();
    now += offset;
    const pointer = new MouseEvent('pointerdown', { bubbles: true });
    now += 100;
    button.dispatchEvent(pointer);
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요');
  });

  it('leaves the normal boundary between two committed syllables alone', () => {
    compositionEvent('compositionstart', '');
    update('요');
    compositionEvent('compositionend', '요');
    compositionEvent('compositionstart', '');
    update('가', '안녕하세요');
    compositionEvent('compositionend', '가');
    pressOutside();
    flushMarkdownComposition(view);
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세요가');
  });

  it('drops a recent reset when a new composition starts before the pointer', () => {
    reset();
    flushMarkdownComposition(view);
    compositionEvent('compositionstart', '');
    pressOutside();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
  });

  it('discards a reset candidate when the document changes before a pointer arrives', () => {
    reset();
    flushMarkdownComposition(view);
    const secondParagraph = view.state.doc.firstChild!.nodeSize + 1;
    view.dispatch(view.state.tr.insertText('새 ', secondParagraph));
    pressOutside();
    expect(view.state.doc.firstChild!.textContent).toBe('안녕하세');
    expect(view.state.doc.lastChild!.textContent).toBe('새 다음 문단');
  });
});
