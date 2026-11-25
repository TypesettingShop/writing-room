import {
  characterFieldLimits, CharacterTemplateValidationError, normalizeCharacterTemplate,
  type CharacterFieldDefinition,
} from '../../../../platform/characters/common/characterFields.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { WorldStoreError, type WorldCategory } from '../../../../platform/world/common/world.js';
import type { WorldStore } from '../../../../platform/world/common/worldStore.js';
import { FieldCardModel, type FieldCardProblem, type FieldCardSnapshot } from '../../../browser/fieldCard/fieldCardModel.js';

export interface WorldCategoryDraft {
  readonly fields: readonly CharacterFieldDefinition[];
}

export function worldCategoryProblem(fields: readonly CharacterFieldDefinition[]): FieldCardProblem | undefined {
  try {
    normalizeCharacterTemplate(fields);
    return undefined;
  } catch (error) {
    if (!(error instanceof CharacterTemplateValidationError)) {
      throw error;
    }
    const index = error.fieldIndex ?? characterFieldLimits.fields;
    return { fieldId: fields[index]?.id ?? '', message: error.detail === 'Label cannot be empty.' ? 'Enter a label.' : error.detail };
  }
}

function sameFields(a: WorldCategoryDraft, b: WorldCategoryDraft): boolean {
  return JSON.stringify(a.fields) === JSON.stringify(b.fields);
}

function sameContent(a: WorldCategoryDraft, b: WorldCategoryDraft): boolean {
  try {
    return sameFields({ fields: normalizeCharacterTemplate(a.fields) }, { fields: normalizeCharacterTemplate(b.fields) });
  } catch (error) {
    if (error instanceof CharacterTemplateValidationError) {
      return sameFields(a, b);
    }
    throw error;
  }
}

export class WorldCategoryFieldsModel extends FieldCardModel<WorldCategoryDraft> {
  constructor(
    workId: string,
    node: WorldCategory,
    revision: number,
    store: Pick<WorldStore, 'updateNode'>,
    read: (minimumRevision?: number) => Promise<FieldCardSnapshot<WorldCategoryDraft> | undefined>,
    label: () => string,
    dialogs: IDialogService,
    notifications: INotificationService,
  ) {
    super({ fields: node.fields }, revision, {
      read,
      write: async (value, expectedRevision) => {
        const result = await store.updateNode(workId, node.id, { fields: [...value.fields] }, expectedRevision);
        return result.node.kind === 'category'
          ? { revision: result.revision, value: { fields: result.node.fields } } : undefined;
      },
      conflictRevision: error => error instanceof WorldStoreError && error.code === 'conflict'
        ? { revision: error.currentRevision } : undefined,
      isNotFound: error => error instanceof WorldStoreError && error.code === 'not_found',
      sameSaved: sameFields,
      sameContent,
      normalize: value => ({ fields: normalizeCharacterTemplate(value.fields) }),
      validate: ({ fields }) => {
        const issue = worldCategoryProblem(fields);
        return issue ? [issue] : [];
      },
      label,
    }, dialogs, notifications);
  }
}
