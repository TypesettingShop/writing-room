import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../../../workbench/common/navigator/navigatorTree.js';
import { normalizeCharacterTemplate } from '../../../characters/common/characterFields.js';
import { isManuscriptId } from '../../../manuscript/common/manuscript.js';
import { worldLimits, worldNodeTypes } from '../../common/world.js';
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

describe('world presets', () => {
  it('offers seven documented presets', () => {
    const list = getWorldPresets();
    expect(list.map(preset => preset.id)).toEqual(Object.keys(genreCategories));
    expect(list.every(preset => preset.label && preset.description)).toBe(true);
  });

  it.each(getWorldPresets())('builds a valid and independent $id tree', ({ id }) => {
    const build = () => buildWorldPresetNodes(id, () => globalThis.crypto.randomUUID(), 10);
    const result = build();
    const options = {
      types: worldNodeTypes, label: (node: { title: string }) => node.title,
      isId: isManuscriptId, maxNodes: worldLimits.nodes, invalidTree: 'Invalid preset tree',
    };
    expect(buildIndex(result, options)).toMatchObject({ ok: true });
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
