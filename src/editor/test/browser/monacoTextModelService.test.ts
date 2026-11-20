import { afterEach, expect, test, vi } from 'vitest';
import { onDidLoadEditor } from '../../../platform/theme/browser/editorThemeHook.js';
import { setEditorTextModelResolver } from '../../browser/textModelServiceHook.js';

// The package is replaced by what the loader touches: the order of its calls is what is tested.
const fake = vi.hoisted(() => {
  const calls: string[] = [];
  class InMemoryTextModelService {
    createModelReference(resource: { toString(): string }) {
      return Promise.resolve({ object: { textEditorModel: 'monaco:' + resource.toString() }, dispose: () => calls.push('monaco released') });
    }
  }
  class SyncDescriptor {
    constructor(readonly ctor: new () => InMemoryTextModelService) {}
  }
  const overrides: Record<string, unknown>[] = [];
  return { calls, overrides, InMemoryTextModelService, SyncDescriptor };
});

vi.mock('monaco-editor', () => ({
  editor: { setTheme: () => fake.calls.push('setTheme'), addKeybindingRule: () => fake.calls.push('addKeybindingRule') },
  KeyCode: { F1: 59 },
}));
vi.mock('monaco-editor/editor/standalone/browser/standaloneServices.js', () => ({
  StandaloneServices: {
    initialize: (overrides: Record<string, unknown>) => {
      fake.calls.push('initialize');
      fake.overrides.push(overrides);
    },
    get: () => {
      fake.calls.push('get');
      return {};
    },
  },
}));
vi.mock('monaco-editor/platform/keybinding/common/keybinding.js', () => ({ IKeybindingService: {} }));
vi.mock('monaco-editor/base/browser/keyboardEvent.js', () => ({ StandardKeyboardEvent: class {} }));
vi.mock('monaco-editor/editor/common/services/inMemoryTextModelService.js', () => ({ InMemoryTextModelService: fake.InMemoryTextModelService }));
vi.mock('monaco-editor/platform/instantiation/common/descriptors.js', () => ({ SyncDescriptor: fake.SyncDescriptor }));

afterEach(() => {
  fake.calls.length = 0;
});

async function loadedService() {
  const { loadMonaco } = await import('../../browser/monaco.js');
  await loadMonaco();
  const descriptor = fake.overrides[0]?.textModelService as InstanceType<typeof fake.SyncDescriptor> | undefined;
  expect(descriptor).toBeInstanceOf(fake.SyncDescriptor);
  return new descriptor!.ctor() as InstanceType<typeof fake.InMemoryTextModelService>;
}

test('the text model service is put in place before anything makes Monaco\'s services', async () => {
  // The theme service listens: it sets the theme, which makes Monaco's services.
  const listening = onDidLoadEditor(() => fake.calls.push('theme announced'));
  try {
    await loadedService();
  } finally {
    listening.dispose();
  }
  // Monaco ignores an override that comes after its services exist; it says nothing.
  expect(fake.calls.indexOf('initialize')).toBe(0);
  expect(fake.calls).toEqual(['initialize', 'theme announced', 'addKeybindingRule', 'get']);
});

test('a resource the workbench resolves comes from its resolver; any other stays with Monaco\'s own service', async () => {
  const service = await loadedService();
  const released: string[] = [];
  const resolving = setEditorTextModelResolver({
    canResolve: resource => resource.startsWith('vscode-vfs:'),
    resolve: async resource => ({ model: 'workbench:' + resource, dispose: () => released.push(resource) }),
  });
  try {
    const file = await service.createModelReference({ toString: () => 'vscode-vfs://writing-room/workspace/defs.lft' });
    expect(file.object.textEditorModel).toBe('workbench:vscode-vfs://writing-room/workspace/defs.lft');
    file.dispose();
    expect(released).toEqual(['vscode-vfs://writing-room/workspace/defs.lft']);

    const synthetic = await service.createModelReference({ toString: () => 'inmemory://model/1' });
    expect(synthetic.object.textEditorModel).toBe('monaco:inmemory://model/1');
  } finally {
    resolving.dispose();
  }
  // Without a workbench (the editor harness), Monaco's own service answers for every resource.
  const file = await service.createModelReference({ toString: () => 'vscode-vfs://writing-room/workspace/defs.lft' });
  expect(file.object.textEditorModel).toBe('monaco:vscode-vfs://writing-room/workspace/defs.lft');
});
