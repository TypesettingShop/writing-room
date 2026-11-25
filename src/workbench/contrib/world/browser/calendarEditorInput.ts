import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService, type BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { GroupIdentifier, IEditorSerializer } from '../../../common/editor.js';
import { ConfirmResult, EditorInput, type IEditorCloseHandler, type IRevertOptions, type ISaveOptions } from '../../../common/editor/editorInput.js';
import { IWorkService } from '../../../services/work/common/work.js';
import { IWorldService } from '../../../services/world/common/worldService.js';
import { CalendarModel } from './calendarModel.js';

export class CalendarEditorInput extends EditorInput {
  static readonly ID = 'workbench.editors.calendar';
  readonly resource: URI;
  readonly model: CalendarModel;
  private readonly changed = this._register(new Emitter<void>());
  readonly onDidChangeState = this.changed.event;

  override readonly closeHandler: IEditorCloseHandler = {
    showConfirm: () => this.isDirty() || this.model.composing,
    confirm: async () => await this.model.card?.confirmClose() ? ConfirmResult.DONT_SAVE : ConfirmResult.CANCEL,
  };

  constructor(
    readonly workId: string,
    @IWorldService world: IWorldService,
    @IDialogService dialogs: IDialogService,
    @INotificationService notifications: INotificationService,
  ) {
    super();
    this.resource = URI.from({ scheme: 'world-calendar', authority: workId });
    this.model = this._register(new CalendarModel(workId, world.store, dialogs, notifications));
    let dirty = false;
    this._register(this.model.onDidChange(() => {
      if (dirty !== this.isDirty()) {
        dirty = this.isDirty();
        this._onDidChangeDirty.fire();
      }
      this.changed.fire();
    }));
    this._register(world.onDidChangeCalendar(workId => {
      if (workId === this.workId) {
        this.model.refresh();
      }
    }));
  }

  override get typeId(): string { return CalendarEditorInput.ID; }
  override getName(): string { return 'Calendar'; }
  override getTabIcon() { return { id: 'world-calendar' }; }
  override isDirty(): boolean { return this.model.card?.dirty ?? false; }

  override async resolve(): Promise<this> {
    if (!this.model.card && !this.isDisposed()) {
      await this.model.retry();
    }
    return this;
  }

  override async save(_group: GroupIdentifier, options?: ISaveOptions): Promise<this | undefined> {
    const model = this.model;
    return !model.composing && await model.card?.save(options?.reason ?? 'explicit') ? this : undefined;
  }

  override async revert(_group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
    await this.model.discardDraft(!options?.soft);
  }
}

export const ICalendarInputService = createDecorator<ICalendarInputService>('calendarInputService');

export interface ICalendarInputService extends BrandedService {
  getOrCreate(workId: string): CalendarEditorInput;
}

class CalendarInputService implements ICalendarInputService {
  declare readonly _serviceBrand: undefined;
  private readonly inputs = new Map<string, CalendarEditorInput>();

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  getOrCreate(workId: string): CalendarEditorInput {
    let input = this.inputs.get(workId);
    if (!input) {
      input = this.instantiation.createInstance(CalendarEditorInput, workId);
      this.inputs.set(workId, input);
      Event.once(input.onWillDispose)(() => this.inputs.delete(workId));
    }
    return input;
  }
}

registerSingleton(ICalendarInputService, CalendarInputService);

export class CalendarEditorSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof CalendarEditorInput;
  }

  serialize(editor: EditorInput): string | undefined {
    return editor instanceof CalendarEditorInput ? editor.workId : undefined;
  }

  deserialize(instantiation: IInstantiationService, workId: string): CalendarEditorInput | undefined {
    return instantiation.invokeFunction(accessor =>
      workId === accessor.get(IWorkService).current?.id
        ? accessor.get(ICalendarInputService).getOrCreate(workId)
        : undefined);
  }
}
