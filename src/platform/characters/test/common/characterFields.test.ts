// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  characterFieldLimits, checkFieldValue, isCharacterFieldId, normalizeCharacterTemplate, normalizeCharacterValues,
} from '../../common/characterFields.js';

const field = { id: 'role', label: 'Role', kind: 'choice', options: ['주연', '조연'] };

describe('character fields', () => {
  it('normalizes labels and choice options and preserves future field kinds', () => {
    const future = { id: 'future', label: '  Cafe\u0301  ', kind: 'futureKind', section: '  Group ' };
    const template = normalizeCharacterTemplate([field, future]);
    expect(template).toEqual([field, { ...future, label: 'Café', section: 'Group' }]);
    expect(template[0].options).not.toBe(field.options);
    expect(checkFieldValue(template[1], 'multi\nline 🐈')).toBe(true);
  });

  it.each([
    [field, field],
    [{ ...field, label: '  ' }],
    [{ ...field, label: 'a'.repeat(characterFieldLimits.label + 1) }],
    [{ ...field, label: '\x00' }],
    [{ ...field, label: '\ud800' }],
    [{ ...field, id: '__proto__' }],
    [{ ...field, options: undefined }],
    [{ ...field, options: [] }],
    [{ ...field, options: ['e\u0301', ' é '] }],
    [{ ...field, kind: 'text' }],
    Array.from({ length: characterFieldLimits.fields + 1 }, (_, index) => ({ ...field, id: `f${index}` })),
  ].map(template => [template]))('rejects invalid template entries %#', template => {
    expect(() => normalizeCharacterTemplate(template)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('enforces normalized UTF-8 sizes, including JSON overhead', () => {
    const template = Array.from({ length: 40 }, (_, index) => ({
      id: `f${index}`, label: '가'.repeat(100), kind: 'longText', placeholder: '가'.repeat(500),
    }));
    expect(() => normalizeCharacterTemplate(template)).toThrow(expect.objectContaining({ code: 'too_large' }));
    const fits = { extra: '가'.repeat(21841) };
    expect(normalizeCharacterValues(fits)).toEqual(fits);
    expect(() => normalizeCharacterValues({ extra: fits.extra + '가' }))
      .toThrow(expect.objectContaining({ code: 'too_large' }));
  });

  it('keeps unrecognized values as entered and reports form mismatches without throwing', () => {
    const values = { retired: '  Cafe\u0301\n🐈  ', role: 'former option' };
    expect(normalizeCharacterValues(values)).toEqual(values);
    expect(normalizeCharacterValues(values)).not.toBe(values);
    expect(checkFieldValue(field, values.role)).toBe(false);
    expect(checkFieldValue(field, '주연')).toBe(true);
    expect(checkFieldValue({ id: 'voice', label: 'Voice', kind: 'text' }, 'two\nlines')).toBe(false);
  });

  it.each([null, [], new Map(), { broke: 1 }, { broke: '\udfff' }, { broke: '\0' }, { '???': '' },
    JSON.parse('{"__proto__":"bad"}'), { constructor: '' }])('rejects malformed values %#', values => {
    expect(() => normalizeCharacterValues(values)).toThrow(expect.objectContaining({ code: 'invalid' }));
  });

  it('accepts stable slugs and generated UUIDs as field ids', () => {
    expect(isCharacterFieldId('narrative-role_2')).toBe(true);
    expect(isCharacterFieldId(crypto.randomUUID())).toBe(true);
    expect(isCharacterFieldId('a'.repeat(characterFieldLimits.id + 1))).toBe(false);
  });
});
