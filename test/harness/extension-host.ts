import '../../src/workbench/workbench.web.main.js';
import { ExtensionIdentifier } from '../../src/platform/extensions/common/extensions.js';
import { ICommandService } from '../../src/platform/commands/common/commands.js';
import { Workbench } from '../../src/workbench/browser/workbench.js';
import type { ExtensionService } from '../../src/workbench/services/extensions/browser/extensionService.js';
import { IExtensionService } from '../../src/workbench/services/extensions/common/extensions.js';

const workbench = new Workbench(document.body.appendChild(document.createElement('main')));
workbench.startup();
const [extensions, commands] = workbench.instantiationService.invokeFunction(accessor =>
  [accessor.get(IExtensionService) as ExtensionService, accessor.get(ICommandService)] as const);
for (const name of ['run', 'fail', 'hang', 'crash']) {
  const id = 'host-fixture.' + name;
  const manifest = {
    publisher: 'writing-room-tests', name, version: '1.0.0', browser: name + '.js',
    contributes: { commands: [{ command: id, title: name }] },
  };
  extensions.addExtension({
    manifest, identifier: ExtensionIdentifier.fromManifest(manifest), isBuiltin: false,
    location: new URL('../fixtures/extensions/host/', location.href).href,
  });
  document.querySelector('#' + name)!.addEventListener('click', () => execute(id));
}
document.querySelector('#restart')!.addEventListener('click', () => {
  extensions.removeExtension('writing-room-tests.crash');
  extensions.removeExtension('writing-room-tests.hang');
  void execute('workbench.action.restartExtensionHost');
});
document.querySelector('#ping')!.addEventListener('click', () => { document.querySelector('#page-result')!.textContent = 'responsive'; });

async function execute(id: string): Promise<void> {
  const result = document.querySelector('#result')!;
  result.textContent = 'pending';
  try {
    result.textContent = JSON.stringify(await commands.executeCommand(id)) ?? 'done';
  } catch (error) {
    result.textContent = String(error);
  }
}
