import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkService, readWindowWork } from '../common/work.js';

export class WorkService implements IWorkService {
  declare readonly _serviceBrand: undefined;
  readonly current = readWindowWork(window.location);
}

/** Report invalid Work links after the workbench can host the notification. */
export class WorkLinkContribution {
  constructor(@IWorkService work: IWorkService, @INotificationService notifications: INotificationService) {
    const url = new URL(window.location.href);
    if (!work.current && url.searchParams.has('work')) {
      notifications.warn('The Work link is not valid.');
      url.searchParams.delete('work');
      window.history.replaceState(window.history.state, '', url);
    }
  }
}
