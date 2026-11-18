import '../../src/workbench/workbench.web.main.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../src/platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../src/platform/commands/common/commands.js';
import { ContextKeyExpr, IContextKeyService } from '../../src/platform/contextkey/common/contextkey.js';
import { InstantiationService } from '../../src/platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../src/platform/instantiation/common/serviceCollection.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../src/platform/keybinding/common/keybindingsRegistry.js';
import { ILayoutService } from '../../src/platform/layout/browser/layoutService.js';
import { IQuickInputService } from '../../src/platform/quickinput/common/quickInput.js';
import { CustomMenubarControl } from '../../src/workbench/browser/parts/titlebar/menubarControl.js';

const layout: ILayoutService = {
  _serviceBrand: undefined,
  mainContainer: document.body,
  get mainContainerDimension() { return { width: window.innerWidth, height: window.innerHeight }; },
  mainContainerOffset: { top: 0, quickPickTop: 30 },
};
const services = new InstantiationService(new ServiceCollection([ILayoutService, layout]));
const { context, commands, quickInput } = services.invokeFunction(accessor => ({
  context: accessor.get(IContextKeyService),
  commands: accessor.get(ICommandService),
  quickInput: accessor.get(IQuickInputService),
}));
const editor = document.querySelector('textarea')!;
context.createScoped(editor).createKey('editorTextFocus', true);
const commandsRun = document.querySelector<HTMLOutputElement>('output[aria-label="Commands Run"]')!;

for (const action of [
  { id: 'test.exportDraft', title: 'Export Draft', category: 'Document', key: 'ctrl+e' },
  { id: 'test.openOutline', title: 'Open Outline', category: 'View' },
  { id: 'test.selectParagraph', title: 'Select Paragraph', category: 'Editor', precondition: ContextKeyExpr.has('editorTextFocus') },
  { id: 'test.disabled', title: 'Disabled Command', precondition: ContextKeyExpr.false() },
]) {
  const { key, ...description } = action;
  registerAction2(class extends Action2 {
    constructor() {
      super({
        ...description,
        f1: true,
        keybinding: key ? { key, weight: KeybindingWeight.WorkbenchContrib } : undefined,
      });
    }

    override run(): void {
      const output = action.title + ' (' + document.activeElement?.tagName + ')';
      commandsRun.value += (commandsRun.value ? ', ' : '') + output;
    }
  });
}
MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
  command: { id: 'test.hidden', title: 'Hidden Command' },
  when: ContextKeyExpr.false(),
});

CommandsRegistry.registerCommand('test.letter', () => { commandsRun.value += 'Letter Binding'; });
KeybindingsRegistry.registerKeybindingRule({
  id: 'test.letter', key: 'x', weight: KeybindingWeight.WorkbenchContrib,
});

const showInput = async () => {
  const result = await quickInput.input({
    title: 'Name the draft',
    placeHolder: 'Draft name',
    value: 'New',
    prompt: 'Use at least five characters.',
    validateInput: value => value.trim().length < 5 ? 'The name is too short.' : undefined,
  });
  document.querySelector<HTMLOutputElement>('output[aria-label="Input Result"]')!.value = result ?? 'Cancelled';
};
CommandsRegistry.registerCommand('test.showInput', showInput);
KeybindingsRegistry.registerKeybindingRule({
  id: 'test.showInput', key: 'f7', weight: KeybindingWeight.WorkbenchContrib,
});

document.querySelector('#input')!.addEventListener('click', () => void showInput());
document.querySelector('#palette')!.addEventListener('click', () => void commands.executeCommand('workbench.action.showCommands'));
document.querySelector('#pick')!.addEventListener('click', async () => {
  const item = await quickInput.pick([
    { label: 'Amber', description: 'Citrus fruit' },
    { type: 'separator', label: 'Other colours' },
    { label: 'Coral', detail: 'A warm pink' },
    { label: 'Indigo', description: 'Night sky' },
  ], { title: 'Choose a colour' });
  document.querySelector<HTMLOutputElement>('output[aria-label="Pick Result"]')!.value = item?.label ?? 'Cancelled';
});

services.createInstance(CustomMenubarControl).installMenubar(document.querySelector<HTMLElement>('#menu')!);
