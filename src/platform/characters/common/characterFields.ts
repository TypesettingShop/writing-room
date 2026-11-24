import { isRecord, utf8Size } from '../../manuscript/common/manuscript.js';
import { characterLimits, CharacterStoreError } from './characters.js';

export type CharacterFieldKind = 'text' | 'longText' | 'choice';

export interface CharacterFieldDefinition {
  id: string;
  label: string;
  // Keep kinds added by newer versions so an older client can round-trip the template.
  kind: string;
  section?: string;
  placeholder?: string;
  options?: string[];
}

export type CharacterTemplate = CharacterFieldDefinition[];
export type CharacterValues = Record<string, string>;

export const characterFieldLimits = {
  fields: 100,
  id: 64,
  kind: 64,
  label: 100,
  section: 100,
  placeholder: 500,
  options: 100,
  option: 100,
  template: 64 * 1024,
  values: characterLimits.values,
} as const;

// PostgreSQL text and the UTF-8 wire format must preserve every accepted string.
const invalidText = /[\x00\uD800-\uDFFF]/u;
const lineBreak = /[\r\n\u2028\u2029]/u;

export function isCharacterFieldId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= characterFieldLimits.id &&
    /^[a-z0-9][a-z0-9_-]*$/i.test(value) && !Object.hasOwn(Object.prototype, value);
}

function isFieldRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.prototype.toString.call(value) === '[object Object]';
}

export class CharacterTemplateValidationError extends CharacterStoreError {
  constructor(
    readonly detail: string,
    readonly fieldIndex?: number,
    code: 'invalid' | 'too_large' = 'invalid',
  ) {
    super(code);
  }
}

function normalizeFieldText(value: unknown, limit: number, name: string, index: number, required = false): string {
  if (typeof value !== 'string' || invalidText.test(value)) {
    throw new CharacterTemplateValidationError(`${name} must be valid text.`, index);
  }
  const text = value.trim().normalize('NFC');
  if (required && !text) {
    throw new CharacterTemplateValidationError(`${name} cannot be empty.`, index);
  }
  if ([...text].length > limit) {
    throw new CharacterTemplateValidationError(`${name} cannot exceed ${limit} characters.`, index);
  }
  return text;
}

function normalizeOptions(value: unknown, index: number): string[] {
  if (!Array.isArray(value) || !value.length) {
    throw new CharacterTemplateValidationError('Add at least one option.', index);
  }
  if (value.length > characterFieldLimits.options) {
    throw new CharacterTemplateValidationError(`A field can have at most ${characterFieldLimits.options} options.`, index);
  }
  const options = Array.from(value, (option, position) =>
    normalizeFieldText(option, characterFieldLimits.option, `Option ${position + 1}`, index, true));
  if (new Set(options).size !== options.length) {
    throw new CharacterTemplateValidationError('Options must be unique.', index);
  }
  return options;
}

function normalizeField(value: unknown, index: number): CharacterFieldDefinition {
  if (!isFieldRecord(value) || !isCharacterFieldId(value.id)) {
    throw new CharacterTemplateValidationError('The field ID is invalid.', index);
  }
  if (typeof value.kind !== 'string' || !value.kind.trim() ||
    value.kind.length > characterFieldLimits.kind || invalidText.test(value.kind)) {
    throw new CharacterTemplateValidationError('The field kind is invalid.', index);
  }
  const field: CharacterFieldDefinition = {
    id: value.id,
    label: normalizeFieldText(value.label, characterFieldLimits.label, 'Label', index, true),
    kind: value.kind,
  };
  if (value.section !== undefined) {
    field.section = normalizeFieldText(value.section, characterFieldLimits.section, 'Section', index);
  }
  if (value.placeholder !== undefined) {
    field.placeholder = normalizeFieldText(value.placeholder, characterFieldLimits.placeholder, 'Placeholder', index);
  }
  if (value.kind === 'choice' || value.options !== undefined) {
    if (value.kind === 'text' || value.kind === 'longText') {
      throw new CharacterTemplateValidationError('This field kind does not support options.', index);
    }
    field.options = normalizeOptions(value.options, index);
  }
  return field;
}

export function normalizeCharacterTemplate(value: unknown): CharacterTemplate {
  if (!Array.isArray(value)) {
    throw new CharacterTemplateValidationError('The template must be a list of fields.');
  }
  if (value.length > characterFieldLimits.fields) {
    throw new CharacterTemplateValidationError(`A template can have at most ${characterFieldLimits.fields} fields.`);
  }
  const template = Array.from(value, normalizeField);
  const ids = new Set<string>();
  for (const [index, field] of template.entries()) {
    if (ids.has(field.id)) {
      throw new CharacterTemplateValidationError('Field IDs must be unique.', index);
    }
    ids.add(field.id);
  }
  if (utf8Size(JSON.stringify(template)) > characterFieldLimits.template) {
    throw new CharacterTemplateValidationError('The field template is too large.', undefined, 'too_large');
  }
  return template;
}

export function normalizeCharacterValues(value: unknown): CharacterValues {
  if (!isFieldRecord(value)) {
    throw new CharacterStoreError('invalid');
  }
  const values: CharacterValues = {};
  for (const [id, text] of Object.entries(value)) {
    if (!isCharacterFieldId(id) || typeof text !== 'string' || invalidText.test(text)) {
      throw new CharacterStoreError('invalid');
    }
    values[id] = text;
  }
  if (utf8Size(JSON.stringify(values)) > characterFieldLimits.values) {
    throw new CharacterStoreError('too_large');
  }
  return values;
}

export function checkFieldValue(field: CharacterFieldDefinition, value: unknown): boolean {
  if (typeof value !== 'string' || invalidText.test(value)) {
    return false;
  }
  switch (field.kind) {
    case 'choice': return field.options?.includes(value) ?? false;
    case 'text': return !lineBreak.test(value);
    default: return true;
  }
}
