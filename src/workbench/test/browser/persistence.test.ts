import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { InMemoryStorageDatabase } from '../../../base/parts/storage/common/storage.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { TestModelService } from '../../../editor/test/common/testTextModel.js';
import { getSingletonServiceDescriptors, registerSingleton } from '../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { InMemoryStorageService, IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import type { StorageValue } from '../../../platform/storage/common/storage.js';
import type { ISerializedBranchNode } from '../../../base/browser/ui/grid/grid.js';
import type { IEditorPartUIState } from '../../browser/parts/editor/editorPart.js';
import { Workbench } from '../../browser/workbench.js';
import { EditorExtensions, EditorsOrder } from '../../common/editor.js';
import type { IEditorFactoryRegistry, IEditorSerializer } from '../../common/editor.js';
import type { ISerializedEditorGroupModel } from '../../common/editor/editorGroupModel.js';
import { GroupDirection, GroupsOrder, IEditorGroupsService } from '../../services/editor/common/editorGroupsService.js';
import { Parts } from '../../services/layout/browser/layoutService.js';
import { UNTITLED_TEXT_LIMIT } from '../../services/untitled/common/untitledTextEditorHandler.js';
import { UntitledTextEditorInput } from '../../services/untitled/common/untitledTextEditorInput.js';
import { IUntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import '../../workbench.web.main.js';

// The real text pane and reload path are exercised in Playwright. Use model doubles in jsdom.
vi.mock('../../browser/parts/editor/textEditor.js', async () => {
  const { EditorPane } = await import('../../browser/parts/editor/editorPane.js');
  return {
    TextEditorPane: class extends EditorPane {
      static readonly ID = 'test.persistence.textEditor';
      constructor() { super('test.persistence.textEditor'); }
      protected createEditor(): void {}
      layout(): void {}
    },
  };
});

vi.mock('../../services/extensionManagement/browser/builtinExtensionsScannerService.js', () => ({
  scanBuiltinExtensions: () => ({ extensions: [], messages: [] }),
}));

const scope = StorageScope.WORKSPACE;
const target = StorageTarget.MACHINE;
const editorKey = 'memento/workbench.parts.editor';
const registry = Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!;
const defaults = new Map(getSingletonServiceDescriptors());
let database: InMemoryStorageDatabase;
let workbench: Workbench | undefined;

class SessionStorage extends InMemoryStorageService {
  constructor() { super(database); }
}

beforeEach(() => {
  database = new InMemoryStorageDatabase();
  registerSingleton(IStorageService, SessionStorage);
  registerSingleton(IModelService, TestModelService);
});

afterEach(() => {
  workbench?.dispose();
  workbench = undefined;
  registerSingleton(IStorageService, defaults.get(IStorageService)!);
  registerSingleton(IModelService, defaults.get(IModelService)!);
  vi.restoreAllMocks();
});

function start(viewport = { width: 800, height: 600 }) {
  workbench?.dispose();
  const current = workbench = new Workbench(document.body);
  Object.defineProperties(current.mainContainer, {
    clientWidth: { value: viewport.width },
    clientHeight: { value: viewport.height },
  });
  current.startup();
  return current.instantiationService.invokeFunction(accessor => ({
    layout: current,
    storage: accessor.get(IStorageService),
    groups: accessor.get(IEditorGroupsService),
    untitled: accessor.get(IUntitledTextEditorService),
  }));
}

async function seed(values: Record<string, StorageValue>): Promise<void> {
  const storage = new SessionStorage();
  for (const [key, value] of Object.entries(values)) {
    const storageScope = key === 'workbench.sideBar.size' || key === 'workbench.panel.size'
      ? StorageScope.PROFILE : scope;
    storage.store(key, value, storageScope, target);
  }
  await storage.flush();
  storage.dispose();
}

function snapshot(storage: IStorageService): IEditorPartUIState {
  return storage.getObject<{ 'editorpart.state': IEditorPartUIState }>(editorKey, scope)!['editorpart.state'];
}

function isLeavePromptArmed(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test.each([
  [20, 170],
  [5000, 452],
  ['wide', 200],
])('restores sidebar size %s as %s and keeps valid layout fields', async (size, width) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seed({
    'workbench.sideBar.size': size,
    'workbench.panel.size': 133,
    'workbench.statusBar.hidden': true,
    'workbench.activityBar.hidden': 'sometimes',
  });

  const { layout, storage } = start();
  expect(layout.layoutState).toMatchObject({ sideBarSize: width, panelSize: 133, statusBarHidden: true, activityBarHidden: false });
  expect(warn).toHaveBeenCalledWith(expect.any(String), { key: 'workbench.activityBar.hidden' });
  if (typeof size === 'string') {
    expect(warn).toHaveBeenCalledWith(expect.any(String), { key: 'workbench.sideBar.size' });
  }
  await storage.flush();

  const restored = start();
  expect(restored.layout.layoutState).toMatchObject({ sideBarSize: width, panelSize: 133, statusBarHidden: true, activityBarHidden: false });
});

test('falls back to the default container for an unknown or relocated selection', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seed({
    'workbench.sidebar.activeviewletid': 'unknown-extension',
    'workbench.panelpart.activepanelid': 'workbench.view.explorer',
  });

  const { layout, storage } = start();
  expect(layout.getContainer(Parts.SIDEBAR_PART).querySelector('h2')?.textContent).toBe('Explorer');
  expect(layout.getContainer(Parts.PANEL_PART).querySelector('[aria-selected="true"]')?.textContent).toBe('Output');
  expect(warn).toHaveBeenCalledWith(expect.any(String), { key: 'workbench.sidebar.activeviewletid', id: 'unknown-extension' });
  expect(warn).toHaveBeenCalledWith(expect.any(String), { key: 'workbench.panelpart.activepanelid', id: 'workbench.view.explorer' });
  await storage.flush();
  expect(storage.get('workbench.sidebar.activeviewletid', scope)).toBe('workbench.view.explorer');
});

test('round-trips group IDs, tab and activation order, and one model shared by two groups', async () => {
  const { groups, storage, untitled } = start();
  const left = groups.activeGroup;
  const first = new UntitledTextEditorInput(untitled.create({ initialValue: 'first' }));
  const text = '한글 😀 \u0000 \ud800';
  const shared = new UntitledTextEditorInput(untitled.create({ initialValue: text }));
  await left.openEditor(first);
  await left.openEditor(shared, { index: 0 });
  await left.openEditor(first);
  const right = groups.addGroup(left, GroupDirection.RIGHT);
  await right.openEditor(shared);
  groups.activateGroup(right);
  await storage.flush();
  const saved = storage.get(editorKey, scope);
  await storage.flush();
  expect(storage.get(editorKey, scope)).toBe(saved);

  const restored = start();
  const [restoredLeft, restoredRight] = restored.groups.getGroups(GroupsOrder.GRID_APPEARANCE);
  expect([restoredLeft.id, restoredRight.id]).toEqual([left.id, right.id]);
  expect(restored.groups.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE)).toEqual([restoredRight, restoredLeft]);
  expect(restored.groups.activeGroup).toBe(restoredRight);
  expect(restoredLeft.editors.map(editor => editor.getName())).toEqual(['Untitled-2', 'Welcome', 'Untitled-1']);
  expect(restoredLeft.getEditors(EditorsOrder.MOST_RECENTLY_ACTIVE).map(editor => editor.getName()))
    .toEqual(['Untitled-1', 'Untitled-2', 'Welcome']);
  expect(restoredLeft.activeEditor?.getName()).toBe('Untitled-1');
  const restoredShared = restoredRight.activeEditor as UntitledTextEditorInput;
  expect(restoredLeft.editors[0]).toBe(restoredShared);
  expect(restoredShared.model.getValue()).toBe(text);
  await restored.storage.flush();
  expect(restored.storage.get(editorKey, scope)).toBe(saved);

  restoredLeft.closeEditor(restoredShared);
  expect(restoredShared.isDisposed()).toBe(false);
  restoredRight.closeEditor(restoredShared);
  expect(restoredShared.isDisposed()).toBe(true);
  const nextUntitled = restored.untitled.create();
  expect(nextUntitled.name).toBe('Untitled-3');
  nextUntitled.dispose();
  expect(restored.groups.addGroup(restoredLeft, GroupDirection.DOWN).id).toBeGreaterThan(right.id);
});

test('keeps valid editors and prunes empty groups when a serializer is unavailable or fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  class ThrowingSerializer implements IEditorSerializer {
    canSerialize(): boolean { return true; }
    serialize(): string { throw new Error('invalid editor'); }
    deserialize(): never { throw new Error('invalid editor'); }
  }
  const registration = registry.registerEditorSerializer('test.throwing', ThrowingSerializer);
  try {
    const original = start();
    const left = original.groups.activeGroup;
    const right = original.groups.addGroup(left, GroupDirection.RIGHT);
    original.groups.activateGroup(right);
    await original.storage.flush();
    const state = snapshot(original.storage);
    const [leftLeaf, rightLeaf] = (state.serializedGrid.root as ISerializedBranchNode).data;
    const leftModel = leftLeaf.data as ISerializedEditorGroupModel;
    leftModel.editors.push({ id: 'test.throwing', value: '' }, { id: 'test.missing', value: '' });
    leftModel.mru.unshift(2, 1);
    const rightModel = rightLeaf.data as ISerializedEditorGroupModel;
    rightModel.editors.push({ id: 'test.missing', value: '' });
    rightModel.mru.push(0);
    await seed({ [editorKey]: { 'editorpart.state': state } });

    const restored = start();
    expect(restored.groups.count).toBe(1);
    expect(restored.groups.activeGroup.id).toBe(left.id);
    expect(restored.groups.activeGroup.activeEditor?.getName()).toBe('Welcome');
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: 'editorpart.state', typeId: 'test.throwing' }));
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: 'editorpart.state', typeId: 'test.missing' }));
  } finally {
    registration.dispose();
  }
});

test('handles an invalid stored grid and remembers closing every editor', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seed({ [editorKey]: { 'editorpart.state': { serializedGrid: { root: [] } } } });

  const fallback = start();
  expect(fallback.groups.count).toBe(1);
  expect(fallback.groups.activeGroup.isEmpty).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ key: 'editorpart.state' }));
  await fallback.storage.flush();

  const restored = start();
  expect(restored.groups.count).toBe(1);
  expect(restored.groups.activeGroup.id).toBe(fallback.groups.activeGroup.id);
  expect(restored.groups.activeGroup.isEmpty).toBe(true);
});

test('budgets UTF-16 units across groups in activation order and guards text left out', async () => {
  const { groups, storage, untitled } = start();
  const left = groups.activeGroup;
  const oldest = new UntitledTextEditorInput(untitled.create({ initialValue: 'x'.repeat(250_000) }));
  const fromRight = new UntitledTextEditorInput(untitled.create({ initialValue: '😀'.repeat(300_000) }));
  const newest = new UntitledTextEditorInput(untitled.create({ initialValue: 'y'.repeat(400_000) }));
  const welcome = left.activeEditor!;
  await left.openEditor(oldest);
  await left.openEditor(welcome);
  const right = groups.addGroup(left, GroupDirection.RIGHT);
  await right.openEditor(fromRight);
  groups.activateGroup(left);
  await left.openEditor(newest);
  expect(isLeavePromptArmed()).toBe(true);

  await storage.flush();
  expect(snapshot(storage).mostRecentUntitledEditors).toEqual([newest.getName(), fromRight.getName()]);
  left.closeEditor(oldest);
  expect(isLeavePromptArmed()).toBe(false);
  await newest.resolve();
  newest.model.textEditorModel!.setValue('y'.repeat(400_001));
  expect(isLeavePromptArmed()).toBe(true);
  newest.model.textEditorModel!.setValue('y'.repeat(400_000));
  expect(isLeavePromptArmed()).toBe(false);

  const restored = start();
  const inputs = restored.groups.groups.flatMap(group => group.editors)
    .filter(editor => editor instanceof UntitledTextEditorInput);
  expect(inputs.map(editor => editor.getName()).sort()).toEqual([fromRight.getName(), newest.getName()]);
  expect(inputs.reduce((length, input) => length + input.model.getValueLength(), 0)).toBe(UNTITLED_TEXT_LIMIT);
});

test('continues saving the other parts when a component throws', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { storage, layout } = start();
  const store = storage.store.bind(storage);
  vi.spyOn(storage, 'store').mockImplementation((key, ...args) => {
    if (key === 'workbench.sideBar.size') {
      throw new Error('failed to save layout');
    }
    store(key, ...args);
  });
  layout.setPartHidden(true, Parts.PANEL_PART);
  await expect(storage.flush()).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith(expect.any(Error));
  expect(snapshot(storage).serializedGrid.root.type).toBe('branch');
  expect(storage.get('workbench.panelpart.activepanelid', scope)).toBe('workbench.panel.output');
});
