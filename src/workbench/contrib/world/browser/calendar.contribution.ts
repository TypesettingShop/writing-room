import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions, EditorPaneDescriptor, type IEditorPaneRegistry } from '../../../browser/editor.js';
import type { IEditorFactoryRegistry } from '../../../common/editor.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkService, WorkOpenContext } from '../../../services/work/common/work.js';
import {
  CalendarEditorInput, CalendarEditorSerializer, ICalendarInputService,
} from './calendarEditorInput.js';
import { CalendarEditorPane } from './calendarEditorPane.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane)!.registerEditorPane(
  EditorPaneDescriptor.create(CalendarEditorPane, CalendarEditorPane.ID, 'Calendar'),
  [CalendarEditorInput.ID],
);
Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(CalendarEditorInput.ID, CalendarEditorSerializer);

registerAction2(class EditCalendar extends Action2 {
  constructor() {
    super({
      id: 'world.editCalendar',
      title: 'Edit Calendar',
      category: 'World',
      f1: true,
      precondition: WorkOpenContext.isEqualTo(true),
      icon: { id: 'world-calendar' },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const work = accessor.get(IWorkService).current;
    if (!work) {
      return;
    }
    const input = accessor.get(ICalendarInputService).getOrCreate(work.id);
    const { activeGroup, groups } = accessor.get(IEditorGroupsService);
    const group = activeGroup.contains(input) ? activeGroup : groups.find(candidate => candidate.contains(input));
    await accessor.get(IEditorService).openEditor(input, undefined, group);
  }
});
