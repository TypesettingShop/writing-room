import '../../src/workbench/platformServices.contribution.js';
import { MenuId, MenuRegistry } from '../../src/platform/actions/common/actions.js';
import { CommandsRegistry } from '../../src/platform/commands/common/commands.js';
import { InstantiationService } from '../../src/platform/instantiation/common/instantiationService.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../src/platform/keybinding/common/keybindingsRegistry.js';
import { CustomMenubarControl } from '../../src/workbench/browser/parts/titlebar/menubarControl.js';

const output = document.querySelector('output')!;
for (const [id, title, key] of [
  ['test.function', 'Function Key', 'f8'],
  ['test.modifier', 'Modifier Key', 'ctrl+f8'],
  ['test.letter', 'Plain Letter', 'x'],
  ['test.chord', 'Chord', 'ctrl+k ctrl+s'],
] as const) {
  CommandsRegistry.registerCommand(id, () => { output.value += (output.value ? ' ' : '') + title; });
  KeybindingsRegistry.registerKeybindingRule({ id, key, weight: KeybindingWeight.WorkbenchContrib });
}
MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, { command: { id: 'test.modifier', title: 'Modifier Key' } });

new InstantiationService().createInstance(CustomMenubarControl).installMenubar(document.querySelector<HTMLElement>('#bar')!);
