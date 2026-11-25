import { normalizeCharacterTemplate, type CharacterTemplate } from '../../characters/common/characterFields.js';
import { normalizeWorldTitle, WorldStoreError, type WorldCategory, type WorldNode } from './world.js';

export const worldPresetIds = ['modern', 'historical', 'fantasy', 'sf', 'wuxia', 'hunter', 'blank'] as const;
export type WorldPresetId = typeof worldPresetIds[number];

export interface WorldPresetCategory {
  title: string;
  fields: CharacterTemplate;
  children: WorldPresetCategory[];
}

export interface WorldPreset {
  id: WorldPresetId;
  label: string;
  description: string;
  categories: WorldPresetCategory[];
}

const timeAndSpace: CharacterTemplate = [
  { id: 'period', label: '시대 구분', kind: 'choice', options: ['현대', '미래', '과거', '가상 차원'] },
  { id: 'stage', label: '주 무대', kind: 'text', placeholder: '도시, 시골, 우주 식민지 등' },
  { id: 'geography', label: '지리와 환경', kind: 'longText' },
  { id: 'climate', label: '기후와 계절', kind: 'longText' },
];

const society: CharacterTemplate = [
  { id: 'politics', label: '정치 체제', kind: 'longText' },
  { id: 'hierarchy', label: '계급·세력 구조', kind: 'longText' },
  { id: 'economy', label: '경제 기반', kind: 'longText', placeholder: '농업, 상업, 자원 채굴 등' },
  { id: 'living', label: '의식주', kind: 'longText' },
  { id: 'beliefs', label: '신념과 풍습', kind: 'longText' },
];

const systems: CharacterTemplate = [
  { id: 'mechanism', label: '작동 방식', kind: 'longText' },
  { id: 'limits', label: '한계', kind: 'longText' },
  { id: 'cost', label: '대가와 부작용', kind: 'longText' },
  { id: 'access', label: '누가 쓸 수 있나', kind: 'longText' },
];

function category(title: string, fields: CharacterTemplate = [], children: WorldPresetCategory[] = []): WorldPresetCategory {
  return { title, fields, children };
}

const place = category('장소', [
  { id: 'location', label: '위치', kind: 'text' },
  { id: 'scenery', label: '풍경과 분위기', kind: 'longText' },
  { id: 'residents', label: '사는 사람들', kind: 'longText' },
  { id: 'story-role', label: '이야기에서의 역할', kind: 'longText' },
]);

const factionFields: CharacterTemplate = [
  { id: 'goal', label: '목표', kind: 'longText' },
  { id: 'members', label: '구성과 규모', kind: 'longText' },
  { id: 'base', label: '근거지', kind: 'text' },
  { id: 'stance', label: '다른 세력과의 관계', kind: 'longText' },
];

const species = category('종족', [
  { id: 'traits', label: '특징', kind: 'longText' },
  { id: 'habitat', label: '사는 곳', kind: 'longText' },
  { id: 'ties', label: '다른 종족과의 관계', kind: 'longText' },
]);

const martialArts = category('무공 체계', [
  { id: 'inner-outer', label: '내공과 외공', kind: 'longText' },
  { id: 'stages', label: '경지', kind: 'longText' },
  { id: 'training', label: '수련 방법', kind: 'longText' },
  { id: 'cost', label: '대가와 부작용', kind: 'longText' },
]);

function rules(...titles: string[]): WorldPresetCategory[] {
  return titles.map(title => category(title, systems));
}

function genre(
  id: Exclude<WorldPresetId, 'blank'>, label: string, description: string, systemCategories: WorldPresetCategory[],
): WorldPreset {
  const settingFields: CharacterTemplate = id === 'historical'
    ? [...timeAndSpace, { id: 'sources', label: '고증 메모', kind: 'longText' }]
    : timeAndSpace;
  const socialCategories = [category(id === 'wuxia' ? '문파' : '세력', factionFields)];
  if (id === 'fantasy') {
    socialCategories.push(species);
  }
  return {
    id, label, description,
    categories: [
      category('시간과 공간', settingFields, [place]),
      category('사회와 문화', society, socialCategories),
      category('핵심 규칙·시스템', systems, systemCategories),
    ],
  };
}

const presets: Record<WorldPresetId, WorldPreset> = {
  modern: genre('modern', '현대', '현대 사회의 장소, 세력과 제도를 정리합니다.', rules('제도와 기술')),
  historical: genre('historical', '역사', '시대 배경과 제도를 정하고 고증 자료를 기록합니다.', rules('제도')),
  fantasy: genre('fantasy', '판타지', '종족, 세력과 마법 체계를 정리합니다.', rules('마법 체계')),
  sf: genre('sf', 'SF', '과학기술의 한계와 우주 이동 방식을 정합니다.', rules('과학기술', '우주와 이동')),
  wuxia: genre('wuxia', '무협', '문파의 관계와 무공의 경지, 수련 방식을 정합니다.', [martialArts]),
  hunter: genre('hunter', '헌터/현대판타지', '게이트와 던전의 규칙, 각성과 등급을 정합니다.', rules('게이트와 던전', '각성과 등급')),
  blank: {
    id: 'blank', label: '빈 세계', description: '기본 분류에 필요한 필드를 직접 추가합니다.',
    categories: ['시간과 공간', '사회와 문화', '핵심 규칙·시스템'].map(title => category(title)),
  },
};

export function getWorldPresets(): WorldPreset[] {
  return structuredClone(worldPresetIds.map(id => presets[id]));
}

export function buildWorldPresetNodes(presetId: string, makeId: () => string, now: number): WorldNode[] {
  if (typeof presetId !== 'string' || !Object.hasOwn(presets, presetId)) {
    throw new WorldStoreError('invalid');
  }
  const { categories } = presets[presetId as WorldPresetId];
  const nodes: WorldNode[] = [];
  function append(siblings: readonly WorldPresetCategory[], parentId: string | null): void {
    siblings.forEach(({ title, fields, children }, position) => {
      const node: WorldCategory = {
        id: makeId(), parentId, kind: 'category', title: normalizeWorldTitle(title), position,
        fields: normalizeCharacterTemplate(fields), createdAt: now, updatedAt: now,
      };
      nodes.push(node);
      append(children, node.id);
    });
  }
  append(categories, null);
  nodes.push({
    id: makeId(), parentId: null, kind: 'calendar', title: '달력', position: categories.length,
    createdAt: now, updatedAt: now,
  });
  return nodes;
}
