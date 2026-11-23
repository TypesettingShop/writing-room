import type { ThemeIcon } from '../../../../base/common/themables.js';

export const characterTypes = ['male', 'female', 'unknown', 'animal'] as const;
type CharacterType = typeof characterTypes[number];

interface CharacterTypeIcon extends ThemeIcon {
  readonly label: string;
}

const icons: Readonly<Record<CharacterType, CharacterTypeIcon>> = {
  male: { id: 'character-male', label: 'Male' },
  female: { id: 'character-female', label: 'Female' },
  unknown: { id: 'character-unknown', label: 'Unknown' },
  animal: { id: 'character-animal', label: 'Animal' },
};

export function characterTypeIcon(type: unknown): CharacterTypeIcon {
  if (typeof type === 'string' && Object.hasOwn(icons, type)) {
    return icons[type as CharacterType];
  }
  return icons.unknown;
}
