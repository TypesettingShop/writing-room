import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
  isManuscriptRevision, ManuscriptStoreError, normalizeManuscriptTitle, type ManuscriptNode,
} from '../../../../platform/manuscript/common/manuscript.js';
import type { ManuscriptStore } from '../../../../platform/manuscript/common/manuscriptStore.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { NavigatorViewState } from '../../../browser/navigator/navigatorViewState.js';
import { IManuscriptService } from '../../../services/manuscript/common/manuscriptService.js';
import { IWorkService } from '../../../services/work/common/work.js';
import { manuscriptTreeOptions } from '../common/manuscriptTree.js';

export type { TitleEdit } from '../../../browser/navigator/navigatorViewState.js';

export const IManuscriptViewState = createDecorator<ManuscriptViewState>('manuscriptViewState');

export class ManuscriptViewState extends NavigatorViewState<ManuscriptNode, ManuscriptStore> {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkService work: IWorkService,
    @IManuscriptService manuscript: IManuscriptService,
    @IStorageService storage: IStorageService,
    @INotificationService notifications: INotificationService,
    @IDialogService dialogs: IDialogService,
  ) {
    super(work.current?.id, manuscript, {
      tree: manuscriptTreeOptions,
      storageKey: 'workbench.manuscript.navigator',
      isRevision: isManuscriptRevision,
      normalizeTitle: title => normalizeManuscriptTitle(title, true),
      isConflict: error => error instanceof ManuscriptStoreError && error.code === 'conflict',
      messages: {
        loadFailed: 'Could not load the manuscript.',
        writeFailed: 'Could not update the manuscript.',
        conflictReloadFailed: 'The manuscript changed elsewhere and could not be reloaded. Use Refresh to try again.',
        conflictReloaded: 'The manuscript changed elsewhere. It has been reloaded.',
      },
    }, storage, notifications, dialogs);
  }
}

registerSingleton(IManuscriptViewState, ManuscriptViewState);
