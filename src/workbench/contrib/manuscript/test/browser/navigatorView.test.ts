import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { IMenuService } from '../../../../../platform/actions/common/actions.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextMenuService.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import type { ManuscriptNode } from '../../../../../platform/manuscript/common/manuscript.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ManuscriptDragAndDropObserver } from '../../../../browser/dnd.js';
import type { IManuscriptService } from '../../../../services/manuscript/common/manuscriptService.js';
import type { IWorkService } from '../../../../services/work/common/work.js';
import type { ManuscriptOpener } from '../../browser/manuscriptOpener.js';
import { ManuscriptViewState } from '../../browser/manuscriptViewState.js';
import { NavigatorView } from '../../browser/navigatorView.js';
import { PropertiesView } from '../../browser/propertiesView.js';
import { UP_KEY } from '../../common/manuscriptTree.js';

const id = (number: number) => '00000000-0000-0000-0000-' + String(number).padStart(12, '0');
function node(number: number, kind: ManuscriptNode['kind'], position: number, parentId: string | null): ManuscriptNode {
  return { id: id(number), kind, parentId, position, title: kind, metadata: {}, createdAt: 0, updatedAt: 0 };
}

const part = node(1, 'part', 0, null);
const chapter = node(2, 'chapter', 0, part.id);
const child = node(3, 'document', 0, chapter.id);
const documentAtRoot = node(4, 'document', 1, null);
const moveNodes = vi.fn(async () => ({ revision: 2 }));
const info = vi.fn();
const disposables = new DisposableStore();
let parent: HTMLElement;
let state: ManuscriptViewState;

beforeEach(async () => {
  const notifications = { info } as unknown as INotificationService;
  const instantiation = new InstantiationService(new ServiceCollection([INotificationService, notifications]));
  const manuscript = {
    onDidChangeTree: Event.None,
    store: { getTree: async () => ({ revision: 1, nodes: [part, chapter, child, documentAtRoot] }), moveNodes },
  } as unknown as IManuscriptService;
  parent = document.body.appendChild(document.createElement('div'));
  disposables.add(toDisposable(() => parent.remove()));
  state = disposables.add(new ManuscriptViewState(
    { current: { id: id(99) } } as IWorkService, manuscript, disposables.add(new InMemoryStorageService()),
    notifications, {} as IDialogService,
  ));
  disposables.add(new NavigatorView(
    parent, state, {} as IContextKeyService, {} as IMenuService, {} as ManuscriptOpener, {} as IContextMenuService, instantiation,
  ));
  const tree = parent.querySelector<HTMLElement>('[role="tree"]')!;
  Object.defineProperty(tree, 'clientHeight', { value: 240 });
  vi.spyOn(tree, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 240, left: 0, right: 200 } as DOMRect);
  await state.ensureLoaded();
});

afterEach(() => {
  ManuscriptDragAndDropObserver.INSTANCE.endDrag();
  disposables.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const row = (key: string) => parent.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
const transfer = () => ({
  types: [] as string[], effectAllowed: 'none', dropEffect: 'none',
  setData(type: string) { this.types.push(type); },
});

function drag(type: string, key: string, dataTransfer: ReturnType<typeof transfer>, offset = 12): MouseEvent {
  const index = state.lines.findIndex(line => line.key === key);
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: index * 24 + offset });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  row(key).dispatchEvent(event);
  return event;
}

test('answers dragenter between rows and drops at the position shown under an open folder', async () => {
  state.toggle(part.id);
  state.toggle(chapter.id);
  const data = transfer();
  drag('dragstart', documentAtRoot.id, data);
  drag('dragenter', documentAtRoot.id, data);
  expect(data.dropEffect).toBe('none');

  const accepted = drag('dragenter', chapter.id, data, 21);
  expect(accepted.defaultPrevented).toBe(true);
  expect(data.dropEffect).toBe('move');
  expect(row(chapter.id).dataset.manuscriptDrop).toBe('after');
  drag('drop', chapter.id, data, 21);

  await vi.waitFor(() => expect(moveNodes).toHaveBeenCalledExactlyOnceWith(
    id(99), [documentAtRoot.id], { parentId: chapter.id, beforeId: child.id }, 1,
  ));
});

test('goes up once on a double click and suppresses the browser menu on the parent row', () => {
  state.enter(chapter.id);
  const contextmenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  row(UP_KEY).dispatchEvent(contextmenu);
  expect(contextmenu.defaultPrevented).toBe(true);
  row(UP_KEY).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  row(UP_KEY).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  expect(state.folderId).toBe(part.id);
});

test('hides a collapsed row’s title input and refuses to start a drag while editing', () => {
  state.toggle(part.id);
  state.startRename(chapter.id);
  const editor = parent.querySelector<HTMLElement>('.manuscript-inline-editor')!;
  expect(editor.hidden).toBe(false);
  expect(drag('dragstart', chapter.id, transfer()).defaultPrevented).toBe(true);
  state.toggle(part.id);
  expect(editor.hidden).toBe(true);
  state.toggle(part.id);
  expect(editor.hidden).toBe(false);
});

test('does not report a refused drop when a native drag ends without a drop event', () => {
  const data = transfer();
  drag('dragstart', documentAtRoot.id, data);
  drag('dragenter', documentAtRoot.id, data);
  drag('dragend', documentAtRoot.id, data);
  expect(info).not.toHaveBeenCalled();
});

test('displays a singular item count for folders with one child', () => {
  state.select(part.id);
  disposables.add(new PropertiesView(parent, state));
  const contents = [...parent.querySelectorAll('dt')].find(field => field.textContent === 'Contents');
  expect(contents?.nextElementSibling?.textContent).toBe('1 item');
});
