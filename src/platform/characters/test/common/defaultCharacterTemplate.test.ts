// @vitest-environment node

import { expect, it } from 'vitest';
import { normalizeCharacterTemplate } from '../../common/characterFields.js';
import { getDefaultCharacterTemplate } from '../../common/defaultCharacterTemplate.js';

it('defines the agreed eight stable fields in order and matches storage normalization', () => {
  const fields = getDefaultCharacterTemplate();
  expect(fields.map(field => [field.id, field.label, field.section])).toEqual([
    ['goal', '목표와 욕구', '핵심 뼈대'],
    ['flaw', '결핍과 약점', '핵심 뼈대'],
    ['reason', '등장 이유', '핵심 뼈대'],
    ['personality', '성격과 가치관', '개성'],
    ['voice', '말투와 버릇', '개성'],
    ['appearance', '외형', '개성'],
    ['role', '역할', '관계와 역할'],
    ['relations', '관계 메모', '관계와 역할'],
  ]);
  expect(fields[6]).toMatchObject({ kind: 'choice', options: ['주연', '조연', '단역'] });
  expect(fields.filter(field => field.id !== 'role').every(field => field.kind === 'longText' && field.placeholder)).toBe(true);
  expect(normalizeCharacterTemplate(fields)).toEqual(fields);
});

it('gives callers their own definitions and choice list', () => {
  const fields = getDefaultCharacterTemplate();
  fields[0].label = 'Changed';
  fields[6].options!.push('Added');
  fields.pop();
  expect(getDefaultCharacterTemplate()).toHaveLength(8);
  expect(getDefaultCharacterTemplate()[0].label).toBe('목표와 욕구');
  expect(getDefaultCharacterTemplate()[6].options).toEqual(['주연', '조연', '단역']);
});
