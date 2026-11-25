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

function templateError(fields: readonly CharacterFieldDefinition[]): CharacterTemplateValidationError | undefined {
  try {
    normalizeCharacterTemplate(fields);
    return undefined;
  } catch (error) {
    if (error instanceof CharacterTemplateValidationError) {
      return error;
    }
    throw error;
  }
}

export function worldCategoryProblems(fields: readonly CharacterFieldDefinition[]): readonly FieldCardProblem[] {
  const error = templateError(fields);
  if (!error) {
    return [];
  }
  if (error.fieldIndex === undefined) {
    return [{ fieldId: fields[characterFieldLimits.fields]?.id ?? '', message: error.detail }];
  }
  const problems: FieldCardProblem[] = [];
  for (const field of fields) {
    const issue = templateError([field]);
    if (issue) {
      problems.push({ fieldId: field.id, message: issue.detail === 'Label cannot be empty.' ? 'Enter a label.' : issue.detail });
    }
  }
  return problems.length ? problems : [{ fieldId: fields[error.fieldIndex]?.id ?? '', message: error.detail }];
}

/**
 * Where a choice field's options keep it from saving, found with the same validator: the first option it rejects,
 * `'add'` when the field has none, or undefined when the problem lies outside the options.
 */
export function worldCategoryOptionProblem(field: CharacterFieldDefinition): number | 'add' | undefined {
  if (field.kind !== 'choice' || templateError([{ ...field, options: ['-'] }])) {
    return undefined;
  }
  const options = field.options ?? [];
  if (!options.length) {
    return 'add';
  }
  for (let end = 1; end <= options.length; end++) {
    if (templateError([{ ...field, options: options.slice(0, end) }])) {
      return end - 1;
    }
  }
  return undefined;
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
      validate: ({ fields }) => worldCategoryProblems(fields),
      label,
    }, dialogs, notifications);
  }
}
