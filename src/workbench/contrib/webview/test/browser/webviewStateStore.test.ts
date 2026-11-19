import { expect, it, vi } from 'vitest';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { WebviewStateStore } from '../../browser/webviewStateStore.js';

it('preserves earlier states and warns once when a pane or the workspace exceeds its byte budget', () => {
  const storage = new InMemoryStorageService();
  const states = new WebviewStateStore(storage);
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const owner = 'fixture.owner';
  const large = JSON.stringify('a'.repeat(256 * 1024 - 2));
  try {
    states.set('first', owner, 'false');
    states.set('first', owner, JSON.stringify('가'.repeat(256 * 1024 / 3)));
    expect(states.get('first', owner)).toBe('false');
    for (let i = 0; i < 4; i++) {
      states.set(String(i), owner, large);
    }
    expect(states.get('2', owner)).toBe(large);
    expect(states.get('3', owner)).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
    storage.dispose();
  }
});

it('checks the owning extension and ignores malformed stored JSON', () => {
  const storage = new InMemoryStorageService();
  const states = new WebviewStateStore(storage);
  try {
    storage.store('webview.states.v1', JSON.stringify([{ id: 'broken', extension: 'fixture.owner', state: '[' }]),
      StorageScope.WORKSPACE, StorageTarget.MACHINE);
    expect(states.get('broken', 'fixture.owner')).toBeUndefined();
    states.set('id', 'fixture.owner', '0');
    states.set('id', 'fixture.other', 'true');
    expect(states.get('id', 'fixture.owner')).toBe('0');
    expect(states.get('id', 'fixture.other')).toBe('true');
    states.removeMissingExtensions(new Set(['fixture.other']));
    expect(states.get('id', 'fixture.owner')).toBeUndefined();
    expect(states.get('id', 'fixture.other')).toBe('true');
    states.delete('id', 'fixture.other');
    expect(states.get('id', 'fixture.other')).toBeUndefined();
  } finally {
    storage.dispose();
  }
});
