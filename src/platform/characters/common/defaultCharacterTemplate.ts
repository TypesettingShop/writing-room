import type { CharacterTemplate } from './characterFields.js';

const defaultCharacterTemplate: CharacterTemplate = [
  { id: 'goal', label: '목표와 욕구', kind: 'longText', section: '핵심 뼈대', placeholder: '이 인물이 원하거나 피하려는 것' },
  { id: 'flaw', label: '결핍과 약점', kind: 'longText', section: '핵심 뼈대', placeholder: '부족한 것, 트라우마' },
  { id: 'reason', label: '등장 이유', kind: 'longText', section: '핵심 뼈대', placeholder: '사건이나 갈등에 개입할 명분' },
  {
    id: 'personality', label: '성격과 가치관', kind: 'longText', section: '개성',
    placeholder: '무엇을 옳다고 믿고, 위기나 분노 앞에서 어떻게 행동하는지',
  },
  {
    id: 'voice', label: '말투와 버릇', kind: 'longText', section: '개성',
    placeholder: '어미, 호흡, 습관. 짧은 대사만으로 누구인지 알 수 있게',
  },
  { id: 'appearance', label: '외형', kind: 'longText', section: '개성', placeholder: '독자가 쉽게 떠올리고 혼동하지 않게' },
  { id: 'role', label: '역할', kind: 'choice', section: '관계와 역할', options: ['주연', '조연', '단역'] },
  {
    id: 'relations', label: '관계 메모', kind: 'longText', section: '관계와 역할',
    placeholder: '주인공과 부딪히거나 빈틈을 채워 주는 지점',
  },
];

export function getDefaultCharacterTemplate(): CharacterTemplate {
  return structuredClone(defaultCharacterTemplate);
}
