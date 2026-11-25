import { FieldCardModel, type FieldCardSnapshot } from '../../../browser/fieldCard/fieldCardModel.js';
import { normalizeCharacterValues, type CharacterValues } from '../../../../platform/characters/common/characterFields.js';
import {
  CharacterStoreError, normalizeCharacterTitle, type CharacterEntry, type CharacterType,
} from '../../../../platform/characters/common/characters.js';
import { type IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { WindowCharactersStore } from '../../../services/characters/common/charactersService.js';

export interface CharacterCardValues {
  readonly title: string;
  readonly type: CharacterType;
  readonly values: Readonly<CharacterValues>;
}

export interface CharacterCardSnapshot {
  readonly node: CharacterEntry | undefined;
  readonly revision: number;
}

function sameValues(a: CharacterCardValues, b: CharacterCardValues): boolean {
  return a.title === b.title && a.type === b.type &&
    Object.keys(a.values).length === Object.keys(b.values).length &&
    Object.entries(a.values).every(([key, value]) => Object.hasOwn(b.values, key) && b.values[key] === value);
}

/** Compares drafts as the store saves them: it trims and NFC-normalizes the title. */
function sameContent(a: CharacterCardValues, b: CharacterCardValues): boolean {
  return sameValues({ ...a, title: a.title.trim().normalize('NFC') }, { ...b, title: b.title.trim().normalize('NFC') });
}

function cardValues(node: CharacterEntry): CharacterCardValues {
  return { title: node.title, type: node.type, values: node.values };
}

function cardSnapshot({ node, revision }: CharacterCardSnapshot): FieldCardSnapshot<CharacterCardValues> {
  return { revision, value: node && cardValues(node) };
}

/** One model per open card, owned by the input that all its tabs share. */
export class CharacterCardModel extends FieldCardModel<CharacterCardValues> {
  readonly id: string;

  constructor(
    workId: string,
    node: CharacterEntry,
    revision: number,
    characters: Pick<WindowCharactersStore, 'updateNode' | 'checkTemplateChanges'>,
    readTree: (minimumRevision?: number) => Promise<CharacterCardSnapshot | undefined>,
    dialogs: IDialogService,
    notifications: INotificationService,
  ) {
    super(cardValues(node), revision, {
      read: async minimumRevision => {
        const snapshot = await readTree(minimumRevision);
        return snapshot && cardSnapshot(snapshot);
      },
      write: async (value, expectedRevision) => {
        const result = await characters.updateNode(workId, node.id, value, expectedRevision);
        return result.node.kind === 'character'
          ? { revision: result.revision, value: cardValues(result.node) }
          : undefined;
      },
      conflictRevision: error => error instanceof CharacterStoreError && error.code === 'conflict'
        ? { revision: error.currentRevision }
        : undefined,
      isNotFound: error => error instanceof CharacterStoreError && error.code === 'not_found',
      sameSaved: sameValues,
      sameContent,
      normalize: value => ({
        title: normalizeCharacterTitle(value.title),
        type: value.type,
        values: normalizeCharacterValues(value.values),
      }),
      label: value => value.title,
      beforeSave: () => { void characters.checkTemplateChanges(workId); },
    }, dialogs, notifications, {
      saveError: 'Could not save the character card.',
      repeatedConflict: 'Characters changed again while saving. Save the card to retry.',
      reloadError: 'Could not reload characters to resolve the save conflict.',
    });
    this.id = node.id;
  }

  acceptTree(snapshot: CharacterCardSnapshot): void {
    this.acceptSnapshot(cardSnapshot(snapshot));
  }
}
