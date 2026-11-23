import { isRecord, utf8Size } from '../../manuscript/common/manuscript.js';
import { CharacterStoreError } from './characters.js';

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
  values: 64 * 1024,
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

function normalizeFieldText(value: unknown, limit: number, required = false): string {
  if (typeof value !== 'string' || invalidText.test(value)) {
    throw new CharacterStoreError('invalid');
  }
  const text = value.trim().normalize('NFC');
  if ((required && !text) || [...text].length > limit) {
    throw new CharacterStoreError('invalid');
  }
  return text;
}

function normalizeOptions(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > characterFieldLimits.options) {
    throw new CharacterStoreError('invalid');
  }
  const options = Array.from(value, option => normalizeFieldText(option, characterFieldLimits.option, true));
  if (new Set(options).size !== options.length) {
    throw new CharacterStoreError('invalid');
  }
  return options;
}

function normalizeField(value: unknown): CharacterFieldDefinition {
  if (!isFieldRecord(value) || !isCharacterFieldId(value.id) ||
    typeof value.kind !== 'string' || !value.kind.trim() ||
    value.kind.length > characterFieldLimits.kind || invalidText.test(value.kind)) {
    throw new CharacterStoreError('invalid');
  }
  const field: CharacterFieldDefinition = {
    id: value.id,
    label: normalizeFieldText(value.label, characterFieldLimits.label, true),
    kind: value.kind,
  };
  if (value.section !== undefined) {
    field.section = normalizeFieldText(value.section, characterFieldLimits.section);
  }
  if (value.placeholder !== undefined) {
    field.placeholder = normalizeFieldText(value.placeholder, characterFieldLimits.placeholder);
  }
  if (value.kind === 'choice' || value.options !== undefined) {
    if (value.kind === 'text' || value.kind === 'longText') {
      throw new CharacterStoreError('invalid');
    }
    field.options = normalizeOptions(value.options);
  }
  return field;
}

export function normalizeCharacterTemplate(value: unknown): CharacterTemplate {
  if (!Array.isArray(value) || value.length > characterFieldLimits.fields) {
    throw new CharacterStoreError('invalid');
  }
  const template = Array.from(value, normalizeField);
  if (new Set(template.map(field => field.id)).size !== template.length) {
    throw new CharacterStoreError('invalid');
  }
  if (utf8Size(JSON.stringify(template)) > characterFieldLimits.template) {
    throw new CharacterStoreError('too_large');
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
