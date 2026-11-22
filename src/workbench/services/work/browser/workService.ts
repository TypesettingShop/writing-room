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
      // Drop only the `work` pairs. Re-serializing searchParams would re-encode every other pair.
      const pairs = url.search.slice(1).split('&').filter(pair => !new URLSearchParams('?' + pair).has('work'));
      url.search = pairs.length ? '?' + pairs.join('&') : '';
      window.history.replaceState(window.history.state, '', url);
    }
  }
}
