import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import { registerExtensionKeybindings } from './keybindingService.js';

ExtensionsRegistry.registerExtensionPoint({
  name: 'keybindings',
  validate: (_value): _value is unknown => true,
  accept: (users, registrations) => registerExtensionKeybindings(users.map(user =>
    isRecord(user.value) ? { ...user, value: [user.value] } : user), registrations),
});
