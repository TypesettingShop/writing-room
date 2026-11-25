import { $, addDisposableListener, append, type Dimension } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { formatCalendarDate } from '../../../../platform/world/common/calendarFormat.js';
import type { CalendarDate } from '../../../../platform/world/common/timePoint.js';
import { DateInput } from '../../../browser/time/dateInput.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { CalendarEditorInput } from './calendarEditorInput.js';
import { CalendarLists } from './calendarLists.js';
import './media/calendar.css';

export class CalendarEditorPane extends EditorPane {
  static readonly ID = 'workbench.editors.calendarPane';

  private readonly inputListeners = this._register(new DisposableStore());
  private readonly lists = this._register(new MutableDisposable<CalendarLists>());
  private readonly preview = this._register(new MutableDisposable<DateInput>());
  private previewDate?: CalendarDate;
  private formatted?: HTMLElement;
  private page!: HTMLElement;
  private summary!: HTMLElement;
  private status!: HTMLElement;
  private content!: HTMLElement;
  private apply!: HTMLButtonElement;
  private discard!: HTMLButtonElement;
  private retry!: HTMLButtonElement;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {
    super(CalendarEditorPane.ID);
  }

  protected createEditor(parent: HTMLElement): void {
    this.page = append(parent, $('section.calendar-editor', { 'aria-label': 'Calendar', tabindex: -1 }));
    append(this.page, $('h1', null, 'Calendar'));
    this.summary = append(this.page, $('p'));
    this.status = append(this.page, $('p', { role: 'status' }));
    const actions = append(this.page, $('.calendar-actions'));
    this.apply = this.action(actions, 'Apply Change', input => input.model.card?.applyChange());
    this.discard = this.action(actions, 'Discard Draft', input => input.model.discardDraft());
    this.retry = this.action(actions, 'Retry', input => input.model.readError
      ? input.model.retry() : input.model.card?.retryReview());
    this.content = append(this.page, $('.calendar-content'));
    this._register(addDisposableListener(this.page, 'focusout', event => {
      if (this.input instanceof CalendarEditorInput && !this.page.contains(event.relatedTarget as Node | null)) {
        this.input.model.card?.scheduleAutoSave(0);
      }
    }));
  }

  override async setInput(input: EditorInput, options: IEditorOptions | undefined): Promise<void> {
    if (this.input !== input) {
      this.clearCalendar();
    }
    await super.setInput(input, options);
    if (this.input === input && input instanceof CalendarEditorInput) {
      if (!this.lists.value) {
        this.inputListeners.clear();
        this.inputListeners.add(input.onDidChangeState(() => this.render(input)));
      }
      this.render(input);
      await input.resolve();
    }
  }

  override clearInput(): void {
    this.clearCalendar();
    super.clearInput();
  }

  private clearCalendar(): void {
    this.inputListeners.clear();
    this.lists.clear();
    this.preview.clear();
    this.previewDate = undefined;
    this.formatted = undefined;
    this.content.replaceChildren();
  }

  override layout(dimension: Dimension): void {
    this.page.style.width = `${dimension.width}px`;
    this.page.style.height = `${dimension.height}px`;
  }

  override focus(): void {
    this.page.focus({ preventScroll: true });
  }

  private action(
    parent: HTMLElement, label: string, run: (input: CalendarEditorInput) => Promise<unknown> | undefined,
  ): HTMLButtonElement {
    const button = append(parent, $('button', { type: 'button', hidden: true }, label));
    this._register(addDisposableListener(button, 'click', async () => {
      const input = this.input;
      if (input instanceof CalendarEditorInput && !input.model.composing) {
        const focused = button === button.ownerDocument.activeElement;
        await run(input);
        if (focused && this.input === input && button.hidden && button.ownerDocument.activeElement === button.ownerDocument.body) {
          this.focus();
        }
      }
    }));
    return button;
  }

  private render(input: CalendarEditorInput): void {
    const { card, readError } = input.model;
    const block = card?.saveBlock;
    if (card && !this.lists.value) {
      this.lists.value = this.instantiation.createInstance(CalendarLists, this.content, input.model);
      this.inputListeners.add(card.onDidRequestSaveBlockFocus(block => {
        if (!this.page.contains(this.page.ownerDocument.activeElement)) {
          return;
        }
        if (block.kind === 'confirmation') {
          this.apply.focus();
        } else if (block.kind === 'reviewError') {
          this.retry.focus();
        }
      }));
    }
    const draft = card?.draft;
    if (draft) {
      if (!this.preview.value) {
        const section = append(this.content, $('section.calendar-list'));
        append(section, $('h2', undefined, 'Preview'));
        const preview = this.preview.value = new DateInput(section.ownerDocument, draft);
        section.appendChild(preview.element);
        this.formatted = append(section, $('p.calendar-preview-result', { 'aria-live': 'polite' }));
        this.inputListeners.add(preview.onDidChange(date => {
          this.previewDate = date;
          this.render(input);
        }));
      } else {
        this.preview.value.setCalendar(draft);
      }
      const formatted = this.previewDate ? formatCalendarDate(draft, this.previewDate) : '';
      if (this.formatted && this.formatted.textContent !== formatted) {
        this.formatted.textContent = formatted;
      }
    }
    const summary = draft
      ? `${draft.eras.length} eras · ${draft.months.length} months · ${draft.months.reduce((days, month) => days + month.days, 0) || '—'} days per year · ${Number.isFinite(draft.hoursPerDay) ? draft.hoursPerDay : '—'} hours per day`
      : '';
    const state = block?.kind === 'confirmation' ? block.hold.message
      : block?.kind === 'reviewError' ? block.message
      : block?.kind === 'validation' ? `Could not save. ${block.problems[0]?.message ?? ''}`
      : card ? card.dirty ? 'Unsaved changes' : 'Saved'
      : 'Loading calendar…';
    const status = readError
      ? card ? `Could not read the saved calendar. ${state}` : 'Could not load the calendar.'
      : state;
    if (this.summary.textContent !== summary) {
      this.summary.textContent = summary;
    }
    if (this.status.textContent !== status) {
      this.status.textContent = status;
    }
    this.apply.hidden = block?.kind !== 'confirmation';
    this.discard.hidden = !block;
    this.retry.hidden = !readError && block?.kind !== 'reviewError';
  }
}
