import { expect, test } from 'vitest';
import { isRecord } from '../../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ExtensionService } from '../../browser/extensionService.js';
import { ExtensionsRegistry } from '../../common/extensionsRegistry.js';

test('applies a late contribution to extensions already scanned and waits for its dependency', () => {
  const order: string[] = [];
  const service = new ExtensionService(() => ({ messages: [], extensions: [{
    isBuiltin: true, identifier: new ExtensionIdentifier('example.test'),
    location: 'https://example.com/',
    manifest: {
      name: 'test', publisher: 'example', version: '1.0.0',
      contributes: { testParent: { registered: true }, testChild: { registered: true } },
    },
  }] }));
  service.initialize();
  const child = ExtensionsRegistry.registerExtensionPoint({
    name: 'testChild', after: ['testParent'], validate: isRecord,
    accept: ([user], _registrations, context) => {
      expect(user.value.registered).toBe(true);
      order.push('child');
      context.addActivationEvent(user.description.identifier.value, 'test:late');
    },
  });
  try {
    expect(order).toEqual([]);
    const parent = ExtensionsRegistry.registerExtensionPoint({
      name: 'testParent', validate: isRecord,
      accept: ([user]) => {
        expect(user.value.registered).toBe(true);
        order.push('parent');
      },
    });
    try {
      expect(order).toEqual(['parent', 'child']);
      expect(service.getExtensionsStatus()['example.test'].activationEvents).toContain('test:late');
    } finally {
      parent.dispose();
    }
  } finally {
    service.dispose();
    child.dispose();
  }
});
