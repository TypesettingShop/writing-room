import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
  isManuscriptId, manuscriptLimits, ManuscriptStoreError, normalizeManuscriptTitle,
} from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { openWelcome } from '../../../browser/parts/editor/welcomeEditor.js';
import { MenubarWorkMenu } from '../../../browser/parts/titlebar/menubar.contribution.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IManuscriptService } from '../../../services/manuscript/common/manuscriptService.js';
import { IWorkService, WorkOpenContext } from '../../../services/work/common/work.js';

const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const units = [
  ['year', 365 * 86400], ['month', 30 * 86400], ['day', 86400],
  ['hour', 3600], ['minute', 60], ['second', 1],
] as const;

function relativeTime(timestamp: number): string {
  const seconds = (timestamp - Date.now()) / 1000;
  const [unit, length] = units.find(([, length]) => Math.abs(seconds) >= length) ?? units[units.length - 1];
  return formatter.format(Math.trunc(seconds / length), unit);
}

async function unavailable(notifications: INotificationService, groups: IEditorGroupsService, message: string): Promise<void> {
  notifications.info(message);
  await openWelcome(groups);
}

registerAction2(class NewWorkAction extends Action2 {
  constructor() {
    super({
      id: 'work.new', title: 'New Work...', category: 'Work', f1: true,
      menu: { id: MenubarWorkMenu, group: '1_work', order: 1 },
    });
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const manuscript = accessor.get(IManuscriptService);
    const notifications = accessor.get(INotificationService);
    const groups = accessor.get(IEditorGroupsService);
    if (manuscript.usesMemory) {
      await unavailable(notifications, groups, 'Works need the server to reopen after navigation.');
      return;
    }
    const work = accessor.get(IWorkService);
    const title = await accessor.get(IQuickInputService).input({
      prompt: 'Work title',
      validateInput: value => {
        try {
          normalizeManuscriptTitle(value, false);
          return undefined;
        } catch {
          return `Enter a Work title of 1–${manuscriptLimits.title} characters without control characters.`;
        }
      },
    });
    if (title === undefined) {
      return;
    }
    await work.createAndOpen(async () => {
      try {
        const created = await manuscript.store.createWork({ title: normalizeManuscriptTitle(title, false) });
        return created.id;
      } catch (error) {
        if (error instanceof ManuscriptStoreError && error.code !== 'unauthorized') {
          notifications.error(error.message);
        } else {
          await unavailable(notifications, groups, 'Sign in to open your Works.');
        }
        return undefined;
      }
    });
  }
});

registerAction2(class OpenWorkAction extends Action2 {
  constructor() {
    super({
      id: 'work.open', title: 'Open Work...', category: 'Work', f1: true,
      menu: { id: MenubarWorkMenu, group: '1_work', order: 2 },
    });
  }

  override async run(accessor: ServicesAccessor, id?: unknown): Promise<void> {
    const work = accessor.get(IWorkService);
    const manuscript = accessor.get(IManuscriptService);
    const notifications = accessor.get(INotificationService);
    const groups = accessor.get(IEditorGroupsService);
    const quickInput = accessor.get(IQuickInputService);
    const commands = accessor.get(ICommandService);
    if (manuscript.usesMemory) {
      await unavailable(notifications, groups, 'Works need the server to reopen after navigation.');
      return;
    }
    if (isManuscriptId(id)) {
      if (id === work.current?.id) {
        return;
      }
      try {
        await manuscript.store.getWork(id);
      } catch (error) {
        if (error instanceof ManuscriptStoreError && error.code !== 'unauthorized') {
          notifications.error(error.message);
        } else {
          await unavailable(notifications, groups, 'Sign in to open your Works.');
        }
        return;
      }
      await work.open(id);
      return;
    }
    let works;
    try {
      works = await manuscript.store.listWorks();
    } catch {
      await unavailable(notifications, groups, 'Sign in to open your Works.');
      return;
    }
    const items = works.map(entry => ({
      id: entry.id, label: entry.title,
      description: relativeTime(entry.updatedAt) + (entry.id === work.current?.id ? ' (current)' : ''),
    }));
    const selected = await quickInput.pick<{ label: string; id?: string }>(
      items.length ? items : [{ label: 'No Works yet' }], { title: 'Open Work...' },
    );
    if (selected?.id) {
      await work.open(selected.id);
    } else if (selected) {
      await commands.executeCommand('work.new');
    }
  }
});

registerAction2(class CloseWorkAction extends Action2 {
  constructor() {
    super({
      id: 'work.close', title: 'Close Work', category: 'Work', f1: true,
      precondition: WorkOpenContext.isEqualTo(true),
      menu: { id: MenubarWorkMenu, group: '2_close', order: 1 },
    });
  }

  override run(accessor: ServicesAccessor): Promise<void> {
    return accessor.get(IWorkService).close();
  }
});
