import { describe, expect, it } from 'vitest';
import { normalizeCharacterTemplate } from '../../../characters/common/characterFields.js';
import { buildWorldPresetNodes, getWorldPresets, type WorldPresetId } from '../../common/worldPresets.js';

const genreCategories: Record<WorldPresetId, string[]> = {
  modern: ['장소', '세력', '제도와 기술'],
  historical: ['장소', '세력', '제도'],
  fantasy: ['장소', '세력', '종족', '마법 체계'],
  sf: ['장소', '세력', '과학기술', '우주와 이동'],
  wuxia: ['장소', '문파', '무공 체계'],
  hunter: ['장소', '세력', '게이트와 던전', '각성과 등급'],
  blank: [],
};

const systems = ['mechanism', 'limits', 'cost', 'access'];
const factions = ['goal', 'members', 'base', 'stance'];
// [parent, field IDs] by category title. Unlisted subcategories copy the core rule fields.
const categoryShape: Record<string, [string | null, string[]]> = {
  '시간과 공간': [null, ['period', 'stage', 'geography', 'climate']],
  '사회와 문화': [null, ['politics', 'hierarchy', 'economy', 'living', 'beliefs']],
  '핵심 규칙·시스템': [null, systems],
  장소: ['시간과 공간', ['location', 'scenery', 'residents', 'story-role']],
  세력: ['사회와 문화', factions],
  문파: ['사회와 문화', factions],
  종족: ['사회와 문화', ['traits', 'habitat', 'ties']],
  '무공 체계': ['핵심 규칙·시스템', ['inner-outer', 'stages', 'training', 'cost']],
};

describe('world presets', () => {
  it('offers seven documented presets', () => {
    const list = getWorldPresets();
    expect(list.map(preset => preset.id)).toEqual(Object.keys(genreCategories));
    expect(list.every(preset => preset.label && preset.description)).toBe(true);
  });

  it.each(getWorldPresets())('builds a valid and independent $id tree', ({ id }) => {
    const build = () => buildWorldPresetNodes(id, () => globalThis.crypto.randomUUID(), 10);
    const result = build();
    expect(result.filter(node => node.parentId === null).map(node => node.title))
      .toEqual(['시간과 공간', '사회와 문화', '핵심 규칙·시스템', '달력']);
    expect(result.filter(node => node.kind === 'calendar')).toEqual([
      expect.objectContaining({ title: '달력', parentId: null, position: 3 }),
    ]);
    expect(result.filter(node => node.parentId !== null).map(node => node.title)).toEqual(genreCategories[id]);
    for (const node of result) {
      expect(node).toMatchObject({ createdAt: 10, updatedAt: 10 });
      if (node.kind === 'category') {
        expect(normalizeCharacterTemplate(node.fields)).toEqual(node.fields);
      }
    }
    if (id === 'blank') {
      expect(result.flatMap(node => node.fields ?? [])).toEqual([]);
    } else {
      const titles = new Map(result.map(node => [node.id, node.title]));
      for (const node of result.filter(node => node.kind === 'category')) {
        const [parent, ids] = categoryShape[node.title] ?? ['핵심 규칙·시스템', systems];
        const expected = id === 'historical' && node.title === '시간과 공간' ? [...ids, 'sources'] : ids;
        expect([node.title, node.parentId && titles.get(node.parentId), node.fields!.map(field => field.id)])
          .toEqual([node.title, parent, expected]);
      }
      expect(result[0].fields!.find(field => field.id === 'period')?.options).toEqual(['현대', '미래', '과거', '가상 차원']);
      expect(result[0].fields!.some(field => field.id === 'sources')).toBe(id === 'historical');
    }
    const listed = getWorldPresets().find(preset => preset.id === id)!;
    listed.categories[0].fields.push({ id: 'unexpected', label: 'Unexpected', kind: 'text' });
    result[0].fields!.push({ id: 'also-unexpected', label: 'Unexpected', kind: 'text' });
    expect(build()[0].fields).toEqual(getWorldPresets().find(preset => preset.id === id)?.categories[0].fields);
    expect(build()[0].fields?.some(field => field.id.includes('unexpected'))).toBe(false);
  });
});
