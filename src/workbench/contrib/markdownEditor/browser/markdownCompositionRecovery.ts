import type { Fragment, Node } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { ReplaceStep } from 'prosemirror-transform';
import type { EditorProps, EditorView } from 'prosemirror-view';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { combinedDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

const resetWindowMs = 50;

interface CompositionDeletion {
  readonly doc: Node;
  readonly from: number;
  readonly content: Fragment;
  readonly historyGroup: number;
}

interface Composition {
  text: string;
  lastInputWasEmpty: boolean;
  endedAt?: number;
  deletion?: CompositionDeletion;
}

export type IMarkdownCompositionInput = Readonly<Pick<Composition, 'text' | 'lastInputWasEmpty'>>;

export function flushMarkdownComposition(view: EditorView): void {
  const { domObserver } = view as EditorView & { domObserver: { forceFlush(always: boolean): void } };
  domObserver.forceFlush(true);
}

/** Some IMEs clear their preedit immediately before delivering a click or focus change. */
export class MarkdownCompositionRecovery {
  private composition: Composition | undefined;
  private committed: Composition | undefined;

  /** Deferred edits keep this reference so a later native update can clear their preedit. */
  get deferredInput(): IMarkdownCompositionInput | undefined {
    return this.composition ?? this.committed;
  }

  readonly handleDOMEvents = {
    compositionstart: view => {
      this.committed = undefined;
      this.composition = view.editable ? { text: '', lastInputWasEmpty: false } : undefined;
    },
    compositionupdate: (_view, event) => {
      const composition = this.composition;
      if (composition && composition.endedAt === undefined && event.data) this.rememberText(composition, event.data);
    },
    beforeinput: (view, event) => {
      this.committed = undefined;
      const composition = this.composition;
      if (!composition) return;
      if (composition.endedAt !== undefined) {
        this.composition = undefined;
      } else if (composition.text && event.inputType === 'insertCompositionText' && !event.data) {
        // Read the last preedit while it is still in the DOM, even if both edits land in one task.
        flushMarkdownComposition(view);
      }
    },
    input: (_view, event) => {
      const composition = this.composition;
      if (!composition || composition.endedAt !== undefined || event.inputType !== 'insertCompositionText') return;
      if (event.data) {
        this.rememberText(composition, event.data);
      } else {
        composition.lastInputWasEmpty = true;
      }
    },
    compositionend: (_view, event) => {
      const composition = this.composition;
      if (composition?.text && composition.endedAt === undefined && (!event.data || composition.lastInputWasEmpty)) {
        // Compare event times: rendering or other tasks between the two dispatches must not use up the window.
        composition.endedAt = event.timeStamp;
      } else {
        if (composition && event.data) {
          this.rememberText(composition, event.data);
          this.committed = composition;
        }
        this.composition = undefined;
      }
    },
  } satisfies NonNullable<EditorProps['handleDOMEvents']>;

  private rememberText(composition: Composition, text: string): void {
    composition.text = text;
    composition.lastInputWasEmpty = false;
    composition.deletion = undefined;
  }

  observeTransaction(transaction: Transaction): void {
    const composition = this.composition;
    if (!composition?.text || !transaction.docChanged) return;
    composition.deletion = undefined;
    const historyGroup: unknown = transaction.getMeta('composition');
    const [step] = transaction.steps;
    const length = composition.text.length;
    if (typeof historyGroup !== 'number' || transaction.steps.length !== 1 || !(step instanceof ReplaceStep)
      || step.slice.openStart || step.slice.openEnd || step.to - step.from - step.slice.size !== length) return;
    const before = transaction.before;
    const from = before.resolve(step.from);
    if (!from.parent.isTextblock || !from.sameParent(before.resolve(step.to))) return;
    // PM can replace a wider span (for example inside a mark). Only recover the lost text.
    const previous = before.slice(step.from, step.to).content;
    const remaining = step.slice.content;
    const prefix = previous.findDiffStart(remaining)!;
    const suffix = previous.findDiffEnd(remaining)!.b;
    // When repeated text makes both ends plausible, prefer the reset's native caret.
    const caret = transaction.selection.head - step.from;
    const offset = Math.max(Math.min(prefix, suffix), Math.min(prefix, caret));
    const end = offset + length;
    const content = previous.cut(offset, end);
    if (content.textBetween(0, content.size) !== composition.text
      || !previous.cut(0, offset).append(previous.cut(end)).eq(remaining)) return;
    composition.deletion = { from: step.from + offset, content, doc: transaction.doc, historyGroup };
  }

  bind(view: EditorView): IDisposable {
    const document = view.dom.ownerDocument;
    const window = document.defaultView!;
    const recover = (event: Event) => this.recover(view, event.timeStamp);
    const editorLosesFocus = (event: FocusEvent) => {
      if (event.target === view.dom) recover(event);
    };
    return combinedDisposable(
      addDisposableListener(document, 'pointerdown', recover, true),
      addDisposableListener(document, 'mousedown', recover, true),
      addDisposableListener(view.dom, 'blur', editorLosesFocus),
      addDisposableListener(view.dom, 'focusout', editorLosesFocus),
      addDisposableListener(window, 'blur', recover),
      addDisposableListener(document, 'visibilitychange', event => {
        if (document.hidden) recover(event);
      }),
    );
  }

  private recover(view: EditorView, at: number): void {
    const composition = this.composition;
    if (composition?.endedAt === undefined) return;
    // The OS can time-stamp the pointer before the reset it triggered, so a negative gap also counts.
    if (view.isDestroyed || !view.editable || at - composition.endedAt > resetWindowMs) {
      this.composition = undefined;
      return;
    }

    // The PM observer may still have the deletion queued when the pointer arrives.
    flushMarkdownComposition(view);
    if (this.composition !== composition) return;
    this.composition = undefined;
    const deletion = composition.deletion;
    if (!deletion || view.isDestroyed || !view.editable || view.state.doc !== deletion.doc) return;
    // Insert at the deletion, letting the transaction map any selection the click already moved.
    view.dispatch(view.state.tr.insert(deletion.from, deletion.content).setMeta('composition', deletion.historyGroup));
  }
}
