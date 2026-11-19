import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import type { FakeMonaco } from '../../../../../editor/test/browser/fakeMonaco.js';
import { resetFakeMonaco } from '../../../../../editor/test/browser/fakeMonaco.js';
import type { ServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InMemoryStorageService, IStorageService } from '../../../../../platform/storage/common/storage.js';
import { asCssVariableName, ColorScheme, DefaultThemeService, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { ISettingsEditorInputService } from '../../../../contrib/preferences/browser/settingsEditorInput.js';
import { GroupDirection, IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import '../../../../workbench.web.main.js';

const monaco = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../../../../editor/browser/monaco.js', async () => {
  const { FakeMonaco } = await import('../../../../../editor/test/browser/fakeMonaco.js');
  monaco.current = new FakeMonaco();
  return { loadMonaco: async () => monaco.current };
});

const disposables = new DisposableStore();
let part: EditorPart;
let instantiation: InstantiationService;
let events: string[];

function service<T>(id: ServiceIdentifier<T>): T {
  return instantiation.invokeFunction(accessor => accessor.get(id));
}

beforeEach(() => {
  const services = new ServiceCollection([IStorageService, disposables.add(new InMemoryStorageService())]);
  instantiation = new InstantiationService(services);
  part = instantiation.createInstance(EditorPart);
  services.set(IEditorGroupsService, part);
  const container = document.body.appendChild(document.createElement('div'));
  part.create(container);
  part.layout(1000, 600, 0, 0);
  disposables.add(part);
  disposables.add({ dispose: () => container.remove() });
  disposables.add(resetFakeMonaco(monaco.current as FakeMonaco));

  events = [];
  const models = service(IModelService);
  disposables.add(models.onModelAdded(model => events.push(`model+ ${model.uri}`)));
  disposables.add(models.onModelRemoved(model => events.push(`model- ${model.uri}`)));
  const editors = service(ICodeEditorService);
  disposables.add(editors.onCodeEditorAdd(() => events.push('editor+')));
  disposables.add(editors.onCodeEditorRemove(() => events.push('editor-')));
});

afterEach(() => disposables.clear());

function newUntitled(): UntitledTextEditorInput {
  return new UntitledTextEditorInput(service(IUntitledTextEditorService).create());
}

test('splitting a text editor adds one code editor and no model; closing takes each away once', async () => {
  const editors = service(ICodeEditorService);
  const models = service(IModelService);
  const input = newUntitled();
  const left = part.activeGroup;
  await left.openEditor(input);
  expect(events).toEqual(['model+ untitled:Untitled-1', 'editor+']);
  expect(editors.listCodeEditors()).toHaveLength(1);

  const right = part.addGroup(left, GroupDirection.RIGHT);
  left.copyEditor(input, right);
  await vi.waitFor(() => expect(editors.listCodeEditors()).toHaveLength(2));
  // Both panes show the one model.
  expect(editors.listCodeEditors().map(editor => editor.getModel())).toEqual([input.model.textEditorModel, input.model.textEditorModel]);
  expect(models.getModels()).toHaveLength(1);

  // Closing the right group's only tab takes the group and its editor away; the model stays for the left tab.
  await right.closeEditor(input);
  expect(part.count).toBe(1);
  expect(editors.listCodeEditors()).toHaveLength(1);
  expect(input.isDisposed()).toBe(false);

  await left.closeEditor(input);
  expect(models.getModels()).toEqual([]);
  expect(events).toEqual(['model+ untitled:Untitled-1', 'editor+', 'editor+', 'editor-', 'model- untitled:Untitled-1']);
});

test('a pane keeps its code editor while it switches models', async () => {
  const editors = service(ICodeEditorService);
  const group = part.activeGroup;
  const first = newUntitled();
  const second = newUntitled();
  await group.openEditor(first);
  const [editor] = editors.listCodeEditors();
  const seen: unknown[] = [];
  editor.onDidChangeModel(() => seen.push(editor.getModel()));

  await group.openEditor(second);
  await group.openEditor(first);
  expect(editors.listCodeEditors()).toEqual([editor]);
  expect(seen).toEqual([null, second.model.textEditorModel, null, first.model.textEditorModel]);
  expect(events.filter(event => event.startsWith('editor'))).toEqual(['editor+']);
});

test('the settings tab adds its model once and removes it once when it closes', async () => {
  const input = service(ISettingsEditorInputService).getOrCreate();
  await part.activeGroup.openEditor(input);
  await part.activeGroup.closeEditor(input);
  expect(events.filter(event => event.startsWith('model'))).toEqual([
    'model+ vscode-userdata:/User/settings.json', 'model- vscode-userdata:/User/settings.json',
  ]);
});

test('the default theme gives the colors workbench.css draws', () => {
  // jsdom gives `import.meta.url` an http origin, so the stylesheet is found from the project root vitest runs in.
  const workbenchCss = readFileSync(join(process.cwd(), 'src/workbench/browser/workbench.css'), 'utf8');
  const block = /\.workbench\s*\{([^}]*)\}/.exec(workbenchCss)![1];
  const variables = [...block.matchAll(/(--vscode-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]);
  expect(variables).toHaveLength(21);

  const theme = service(IThemeService).getColorTheme();
  expect(theme.id).toBe(new DefaultThemeService().getColorTheme().id);
  expect(theme.type).toBe(ColorScheme.DARK);
  for (const [name, value] of variables) {
    const id = name.slice('--vscode-'.length).replace(/-/g, '.');
    expect(asCssVariableName(id)).toBe(name);
    expect(theme.defines(id)).toBe(true);
    expect(theme.getColor(id), id).toBe(value);
  }
  expect(theme.getColor('nonexistent.color')).toBeUndefined();
  expect(theme.getColor('toString')).toBeUndefined();
  expect(theme.tokenColors.length).toBeGreaterThan(0);
});
