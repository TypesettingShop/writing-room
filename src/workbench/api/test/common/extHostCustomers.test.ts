// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { ExtHostCustomers, runCustomerCleanup } from '../../../services/extensions/common/extHostCustomers.js';
import { createTestRpcPair } from './testExtensionHost.js';

test('registers independent customers per session and unregisters the factory', () => {
  const pair = createTestRpcPair();
  const registry = new ExtHostCustomers();
  const factory = vi.fn(() => ({ remove: vi.fn(), dispose: vi.fn() }));
  const handle = registry.register('test', factory);
  const create = () => registry.create({
    rpc: pair.main, instantiation: new InstantiationService(),
    getExtension: () => undefined, commandOwner: () => undefined, activate: async () => {},
  });
  try {
    const [first] = create();
    const [second] = create();
    expect(first).not.toBe(second);
    expect(() => registry.register('test', factory)).toThrow("Extension customer 'test' already exists.");
    handle.dispose();
    expect(create()).toEqual([]);
    const replacement = registry.register('test', factory);
    try {
      handle.dispose();
      expect(create()).toHaveLength(1);
    } finally {
      replacement.dispose();
    }
    runCustomerCleanup([first], customer => customer.remove?.('removed'));
    runCustomerCleanup([first], customer => customer.dispose?.());
    expect(first.remove).toHaveBeenCalledExactlyOnceWith('removed');
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.remove).not.toHaveBeenCalled();
  } finally {
    handle.dispose();
    pair.dispose();
  }
});
