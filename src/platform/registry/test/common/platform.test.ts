import { expect, test } from 'vitest';
import { Registry } from '../../common/platform.js';

test('looks up registered objects and rejects duplicate names', () => {
  const id = 'test.registry';
  const value = { name: 'registered' };

  expect(Registry.knows(id)).toBe(false);
  expect(Registry.as<typeof value>(id)).toBeNull();
  Registry.add(id, value);
  expect(Registry.knows(id)).toBe(true);
  expect(Registry.as<typeof value>(id)).toBe(value);
  expect(() => Registry.add(id, { name: 'duplicate' })).toThrow(id);
  expect(Registry.as<typeof value>(id)).toBe(value);
});
