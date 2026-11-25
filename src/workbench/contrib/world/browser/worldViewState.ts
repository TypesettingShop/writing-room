import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId, isManuscriptRevision } from '../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { normalizeWorldTitle, worldLimits, worldNodeTypes, WorldStoreError, type WorldNode, type WorldNodeKind } from '../../../../platform/world/common/world.js';
import type { WorldPresetId } from '../../../../platform/world/common/worldPresets.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import { NavigatorViewState } from '../../../browser/navigator/navigatorViewState.js';
import { labelOf, preorder } from '../../../common/navigator/navigatorTree.js';
import { IWorkService } from '../../../services/work/common/work.js';
import { IWorldService } from '../../../services/world/common/worldService.js';

export const IWorldViewState = createDecorator<WorldViewState>('worldViewState');

export class WorldViewState extends NavigatorViewState<WorldNode, WorldStore> {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkService work: IWorkService,
    @IWorldService world: IWorldService,
    @IStorageService storage: IStorageService,
    @INotificationService notifications: INotificationService,
    @IDialogService dialogs: IDialogService,
  ) {
    super(work.current?.id, world, {
      tree: {
        types: worldNodeTypes,
        label: node => node.title || 'Untitled',
        maxNodes: worldLimits.nodes,
        isId: isManuscriptId,
        invalidTree: 'The world tree is invalid.',
      },
      storageKey: 'workbench.world.navigator',
      isRevision: isManuscriptRevision,
      normalizeTitle: normalizeWorldTitle,
      isConflict: error => error instanceof WorldStoreError && error.code === 'conflict',
      deleteMessage: (node, index) => {
        const title = labelOf(node, index);
        if (node.kind === 'item') {
          return `Delete "${title}"?`;
        }
        let itemCount = 0;
        for (const descendant of preorder(node.id, index)) {
          if (descendant.kind === 'item') {
            itemCount++;
          }
        }
        return `Delete "${title}" and ${itemCount} ${itemCount === 1 ? 'item' : 'items'} in it?`;
      },
      messages: {
        loadFailed: 'Could not load the world.',
        writeFailed: 'Could not update the world.',
        conflictReloadFailed: 'The world changed elsewhere and could not be reloaded. Use Refresh to try again.',
        conflictReloaded: 'The world changed elsewhere. It has been reloaded.',
      },
    }, storage, notifications, dialogs);
  }

  override creationParent(kind: WorldNodeKind, selection = this.singleSelection()): string | null | undefined {
    if ((kind === 'category' || kind === 'item') && selection?.kind === 'item') {
      selection = this.index?.nodes.get(selection.parentId ?? '');
    }
    return super.creationParent(kind, selection);
  }

  override async deleteSelected(): Promise<void> {
    if (this.singleSelection()?.kind !== 'calendar') {
      await super.deleteSelected();
    }
  }

  async applyPreset(id: WorldPresetId): Promise<void> {
    if (this.index?.nodes.size === 0) {
      await this.write((store, workId, revision) => store.applyPreset(workId, id, revision));
    }
  }
}

registerSingleton(IWorldViewState, WorldViewState);
