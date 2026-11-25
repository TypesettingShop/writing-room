import { normalizeCharacterValues, type CharacterValues } from '../../../../platform/characters/common/characterFields.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { normalizeWorldTitle, WorldStoreError, type WorldItem } from '../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import { FieldCardModel, type FieldCardSnapshot } from '../../../browser/fieldCard/fieldCardModel.js';

export interface WorldItemDraft {
  readonly title: string;
  readonly values: Readonly<CharacterValues>;
}

export function worldItemDraft({ title, values }: WorldItem): WorldItemDraft {
  return { title, values };
}

function sameValues(a: WorldItemDraft, b: WorldItemDraft): boolean {
  return Object.keys(a.values).length === Object.keys(b.values).length &&
    Object.entries(a.values).every(([key, value]) => Object.hasOwn(b.values, key) && b.values[key] === value);
}

export class WorldItemCardModel extends FieldCardModel<WorldItemDraft> {
  constructor(
    workId: string,
    node: WorldItem,
    revision: number,
    store: Pick<WorldStore, 'updateNode'>,
    read: (minimumRevision?: number) => Promise<FieldCardSnapshot<WorldItemDraft> | undefined>,
    dialogs: IDialogService,
    notifications: INotificationService,
  ) {
    super(worldItemDraft(node), revision, {
      read,
      write: async (value, expectedRevision) => {
        const result = await store.updateNode(workId, node.id, value, expectedRevision);
        return result.node.kind === 'item' ? { revision: result.revision, value: worldItemDraft(result.node) } : undefined;
      },
      conflictRevision: error => error instanceof WorldStoreError && error.code === 'conflict'
        ? { revision: error.currentRevision } : undefined,
      isNotFound: error => error instanceof WorldStoreError && error.code === 'not_found',
      sameSaved: (a, b) => a.title === b.title && sameValues(a, b),
      sameContent: (a, b) => a.title.trim().normalize('NFC') === b.title.trim().normalize('NFC') && sameValues(a, b),
      normalize: value => ({ title: normalizeWorldTitle(value.title), values: normalizeCharacterValues(value.values) }),
      label: value => value.title,
      conflictDetail: 'Reload to discard your edits and read the saved item. Overwrite replaces the other changes with your edits.',
    }, dialogs, notifications, {
      saveError: 'Could not save the item.',
      repeatedConflict: 'The world changed again while saving. Save the item to retry.',
      reloadError: 'Could not reload the world to resolve the save conflict.',
    });
  }
}
