import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { CalendarValidationError, calendarLimits, getGregorianCalendar, normalizeCalendar, type Calendar } from '../../../../platform/world/common/calendar.js';
import { WorldStoreError } from '../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import { FieldCardModel, type FieldCardSnapshot } from '../../../browser/fieldCard/fieldCardModel.js';
import { countCalendarImpact } from './calendarUsage.js';

function sameCalendar(a: Calendar, b: Calendar): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

export class CalendarModel extends Disposable {
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChange = this.changed.event;
  private _card?: FieldCardModel<Calendar>;
  private latest?: { revision: number; value: Calendar };
  private retrying?: Promise<void>;
  private minimumRevision = 0;
  private writing = false;
  private compositions = 0;
  private readonly rowIds = new Set<string>();
  private disposed = false;
  private _readError = false;

  constructor(
    private readonly workId: string,
    private readonly worldStore: Pick<WorldStore, 'getCalendar' | 'putCalendar'>,
    private readonly dialogs: IDialogService,
    private readonly notifications: INotificationService,
  ) {
    super();
    this.rememberIds(getGregorianCalendar());
  }

  get card() { return this._card; }
  get readError() { return this._readError; }
  get saved() { return this.latest?.value; }
  get composing() { return this.compositions > 0; }

  beginComposition(): IDisposable {
    const composition = this.card?.beginComposition();
    this.compositions++;
    return toDisposable(() => {
      this.compositions--;
      composition?.dispose();
    });
  }

  newRowId(): string {
    const draft = this.card?.draft;
    if (draft) {
      this.rememberIds(draft);
    }
    let id: string;
    do {
      id = crypto.randomUUID();
    } while (this.rowIds.has(id));
    this.rowIds.add(id);
    return id;
  }

  private rememberIds(calendar: Calendar): void {
    for (const row of [...calendar.eras, ...calendar.months]) {
      this.rowIds.add(row.id);
    }
  }

  refresh(): void {
    // A successful PUT is followed by the card's revision-bounded read.
    if (!this.writing) {
      void this.retry();
    }
  }

  retry(): Promise<void> {
    return this.retrying ??= this.read().then(snapshot => {
      if (!snapshot || this.disposed) {
        return;
      }
      if (this.card) {
        this.card.acceptSnapshot(snapshot);
      } else {
        this.initialize(snapshot);
      }
      this.changed.fire();
    }).finally(() => { this.retrying = undefined; });
  }

  async discardDraft(refresh = false): Promise<void> {
    if (refresh) {
      await this.card?.waitForSave();
      await this.retry();
      if (this.readError) {
        return;
      }
    }
    await this.card?.discardDraft();
    if (this.latest && !this.card?.dirty) {
      this.card?.acceptSnapshot(this.latest);
    }
  }

  private async read(minimumRevision = 0): Promise<{ revision: number; value: Calendar } | undefined> {
    try {
      const snapshot = await this.worldStore.getCalendar(this.workId);
      if (this.disposed) {
        return undefined;
      }
      if (snapshot.revision < Math.max(minimumRevision, this.minimumRevision)) {
        throw new Error('The saved calendar revision is unavailable.');
      }
      return this.remember(snapshot.revision, snapshot.calendar);
    } catch {
      if (!this.disposed && !this._readError) {
        this._readError = true;
        this.changed.fire();
      }
      return undefined;
    }
  }

  private remember(revision: number, calendar: Calendar): { revision: number; value: Calendar } {
    if (!this.latest || revision > this.latest.revision) {
      this.latest = { revision, value: normalizeCalendar(calendar) };
      this.rememberIds(this.latest.value);
    }
    if (this._readError) {
      this._readError = false;
      this.changed.fire();
    }
    return this.latest;
  }

  private initialize({ value, revision }: Required<FieldCardSnapshot<Calendar>>): void {
    const card = this._card = this._register(new FieldCardModel<Calendar>(value, revision, {
      read: minimumRevision => this.read(minimumRevision),
      write: async (draft, expectedRevision) => {
        // The shared close flow can invoke Apply and Close on a failed review.
        // Only Retry is allowed to clear that failure and run the check again.
        if (this.composing || this.card?.saveBlock?.kind === 'reviewError') {
          return undefined;
        }
        this.writing = true;
        try {
          const snapshot = await this.worldStore.putCalendar(this.workId, draft, expectedRevision);
          this.remember(snapshot.revision, snapshot.calendar);
          return { revision: snapshot.revision, value: snapshot.calendar };
        } finally {
          this.writing = false;
        }
      },
      conflictRevision: error => {
        if (error instanceof WorldStoreError && error.code === 'conflict') {
          this.minimumRevision = Math.max(this.minimumRevision, error.currentRevision ?? 0);
          return { revision: error.currentRevision };
        }
        return undefined;
      },
      isNotFound: () => false,
      sameSaved: sameCalendar,
      sameContent: (a, b) => {
        try {
          return sameCalendar(normalizeCalendar(a), normalizeCalendar(b));
        } catch {
          return sameCalendar(a, b);
        }
      },
      normalize: normalizeCalendar,
      label: () => 'Calendar',
      conflictDetail: 'Reload to discard your edits and read the saved calendar. Overwrite replaces the other changes with your edits.',
      validate: draft => {
        try {
          normalizeCalendar(draft);
          return [];
        } catch (error) {
          if (!(error instanceof CalendarValidationError)) {
            throw error;
          }
          // Collection-size errors are reported at calendar scope by the validator.
          // Attach overflow to the first excess row and an empty list to its Add button.
          let fieldId: string = error.index === undefined ? error.row : `${error.row}-${error.index}`;
          if (error.row === 'calendar' && error.detail.endsWith(' eras.')) {
            fieldId = draft.eras.length ? `era-${calendarLimits.eras}` : 'eras';
          } else if (error.row === 'calendar' && error.detail.endsWith(' months.')) {
            fieldId = draft.months.length ? `month-${calendarLimits.months}` : 'months';
          }
          return [{ fieldId, message: error.detail }];
        }
      },
      review: async (draft, saved) => {
        const counts = (await countCalendarImpact(this.workId, saved, draft)).filter(entry => entry.count > 0);
        if (!counts.length) {
          return undefined;
        }
        const affected = counts.map(entry => `${entry.count} ${entry.label}`).join(' and ');
        return {
          message: `This change makes ${affected} need review. Discard Draft keeps these dates as they are. A new era or month with the same name will not take them back.`,
        };
      },
    }, this.dialogs, this.notifications, {
      saveError: 'Could not save the calendar.',
      reloadError: 'Could not reload the calendar to resolve the save conflict.',
      repeatedConflict: 'The calendar changed again while saving. Save the calendar to retry.',
    }));
    this._register(card.onDidChange(() => {
      this.rememberIds(card.draft);
      this.changed.fire();
    }));
  }

  override dispose(): void {
    this.disposed = true;
    super.dispose();
  }
}
