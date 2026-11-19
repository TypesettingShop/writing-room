import { ExtensionsRegistry } from '../../extensions/common/extensionsRegistry.js';
import { registerExtensionKeybindings } from './keybindingService.js';

ExtensionsRegistry.registerExtensionPoint({
  name: 'keybindings',
  validate: (_value): _value is unknown => true,
  accept: registerExtensionKeybindings,
});
