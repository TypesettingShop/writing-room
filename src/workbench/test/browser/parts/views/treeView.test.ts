import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ColorScheme } from '../../../../../platform/theme/common/themeService.js';
import type { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { ExtensionTreeViews, MainThreadTreeViews } from '../../../../api/browser/mainThreadTreeViews.js';
import type { TreeItemDto } from '../../../../api/common/extHost.protocol.js';
import { TreeViewPane } from '../../../../browser/parts/views/treeView.js';
import { viewWelcomeContributions } from '../../../../browser/parts/views/treeViewWelcome.js';
import type { IExtensionService } from '../../../../services/extensions/common/extensions.js';

const folder = 'https://example.com/extensions/a/';
let disposables: DisposableStore;
let themeType: ColorScheme;
let themeChanged: Emitter<IColorTheme>;
let readFile: ReturnType<typeof vi.fn<IFileService['readFile']>>;
let open: ReturnType<typeof vi.fn<IOpenerService['open']>>;
let context: ContextKeyService;
let views: ExtensionTreeViews;
let section: HTMLElement;
let children: Map<string | undefined, TreeItemDto[]>;
let calls: { selection: string[][]; expanded: [string, boolean][] };
let blobs: Set<string>;

beforeEach(() => {
  disposables = new DisposableStore();
  themeType = ColorScheme.DARK;
  themeChanged = disposables.add(new Emitter<IColorTheme>());
  readFile = vi.fn<IFileService['readFile']>(async resource => {
    const size = resource.path.includes('huge') ? 256 * 1024 + 1 : 10;
    return { value: new Uint8Array(size) } as Awaited<ReturnType<IFileService['readFile']>>;
  });
  open = vi.fn<IOpenerService['open']>(async () => true);
  context = disposables.add(new ContextKeyService());
  views = disposables.add(new ExtensionTreeViews());
  children = new Map();
  calls = { selection: [], expanded: [] };
  blobs = new Set();
  let next = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = 'blob:icon-' + ++next;
    blobs.add(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void blobs.delete(url));
  section = document.createElement('section');
  section.className = 'view-pane';
  section.setAttribute('aria-label', 'Original');
  section.innerHTML = '<header class="view-pane-header"><h3>Original</h3></header><div class="view-pane-body"></div>';
  document.body.append(section);
});

afterEach(() => {
  disposables.dispose();
  section.remove();
  vi.restoreAllMocks();
});

async function register(options: { canSelectMany?: boolean } = {}) {
  const trees = disposables.add(new MainThreadTreeViews({
    $getChildren: async (_extension, _view, parent) => children.get(parent) ?? [],
    $getTreeItem: async () => undefined,
    $setSelection: async (_extension, _view, handles) => void calls.selection.push(handles),
    $setExpanded: async (_extension, _view, handle, expanded) => void calls.expanded.push([handle, expanded]),
  }, views, () => true, { iconFolders: () => [folder] }));
  await trees.$registerTreeViewDataProvider('a', 'tree', {
    showCollapseAll: true, canSelectMany: !!options.canSelectMany, manageCheckboxStateManually: false,
    dropMimeTypes: [], dragMimeTypes: [], hasHandleDrag: false, hasHandleDrop: false,
  });
  return trees;
}

function createPane(): TreeViewPane {
  const theme: IThemeService = {
    _serviceBrand: undefined,
    getColorTheme: () => ({ type: themeType }) as IColorTheme,
    onDidColorThemeChange: themeChanged.event,
  };
  const commands = { executeCommand: vi.fn(async () => undefined) } as unknown as ICommandService;
  return disposables.add(new TreeViewPane(
    section.querySelector('.view-pane-body')!, 'tree',
    { activateByEvent: async () => {} } as unknown as IExtensionService, views,
    commands, context, { getMenuActions: () => [] } as never, { showContextMenu: () => {} } as never,
    { readFile } as unknown as IFileService, theme, { open } as unknown as IOpenerService,
  ));
}

const rows = () => [...section.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const row = (label: string) => rows().find(element => element.querySelector('.extension-tree-label')?.textContent === label)!;

test('draws codicons with a registered color, and images from the extension through blob URLs', async () => {
  const uri = (path: string) => URI.parse(folder + path);
  children.set(undefined, [
    { handle: 'theme', label: 'Theme', collapsible: 0, icon: { kind: 'theme', id: 'pass', color: 'charts.green' } },
    { handle: 'image', label: 'Image', collapsible: 0, icon: { kind: 'uri', light: uri('light.svg'), dark: uri('dark.svg') } },
    { handle: 'huge', label: 'Huge', collapsible: 0, icon: { kind: 'uri', light: uri('huge.svg'), dark: uri('huge.svg') } },
  ]);
  await register();
  createPane();
  await vi.waitFor(() => expect(row('Image')?.querySelector('img')).toBeTruthy());
  const codicon = row('Theme').querySelector<HTMLElement>('.extension-tree-icon')!;
  expect(codicon.classList).toContain('codicon-pass');
  expect(codicon.style.color).toBe('var(--vscode-charts-green)');
  const dark = row('Image').querySelector('img')!;
  expect(dark.getAttribute('src')).toMatch(/^blob:/);
  expect(dark.dataset.icon).toBe('dark');
  expect(readFile).toHaveBeenCalledWith(uri('dark.svg'), expect.objectContaining({ limits: { size: 256 * 1024 } }));
  // An icon over the limit is not shown, even when the reader returns more than asked.
  expect(row('Huge').querySelector('img')).toBeNull();

  themeType = ColorScheme.LIGHT;
  themeChanged.fire({ type: themeType } as IColorTheme);
  await vi.waitFor(() => expect(row('Image').querySelector('img')?.dataset.icon).toBe('light'));
  expect(readFile).toHaveBeenCalledWith(uri('light.svg'), expect.anything());
  // The dark image is no longer drawn, so its URL is gone.
  expect(blobs.has(dark.getAttribute('src')!)).toBe(false);
  expect(blobs.size).toBe(1);
});

test('shows the welcome text only for an empty tree, runs declared commands and opens web links', async () => {
  const declared = 'tree.create';
  const shown = context.createKey<boolean>('treeWelcome', true);
  const slot = viewWelcomeContributions.replace([{
    view: 'tree', when: ContextKeyExpr.deserialize('treeWelcome'), commands: [declared],
    contents: 'No notes <b>yet</b>.\n[Create Note](command:tree.create)\nRead [the guide](https://example.com/guide), '
      + '[run other](command:other.command), [with args](command:tree.create?%5B1%5D) or [a file](file:///etc/passwd).',
  }]);
  try {
    await register();
    createPane();
    const welcome = () => section.querySelector('.tree-view-welcome');
    await vi.waitFor(() => expect(welcome()).toBeTruthy());
    expect(welcome()!.querySelector('b')).toBeNull();
    expect(welcome()!.textContent).toContain('No notes <b>yet</b>.');
    const button = welcome()!.querySelector('button')!;
    expect(button.textContent).toBe('Create Note');
    button.click();
    expect(open).toHaveBeenCalledExactlyOnceWith(URI.from({ scheme: 'command', path: declared }), { allowCommands: [declared] });
    const links = [...welcome()!.querySelectorAll('a')];
    expect(links.map(link => link.textContent)).toEqual(['the guide']);
    links[0].click();
    expect(open).toHaveBeenLastCalledWith('https://example.com/guide');
    expect(welcome()!.textContent).toContain('run other, with args or a file.');

    shown.set(false);
    await vi.waitFor(() => expect(welcome()).toBeNull());
    shown.set(true);
    await vi.waitFor(() => expect(welcome()).toBeTruthy());
  } finally {
    slot.dispose();
  }
});

test('a tree with items does not show the welcome text', async () => {
  children.set(undefined, [{ handle: 'one', label: 'One', collapsible: 0 }]);
  const slot = viewWelcomeContributions.replace([{ view: 'tree', contents: 'Welcome', commands: [] }]);
  try {
    await register();
    createPane();
    await vi.waitFor(() => expect(row('One')).toBeTruthy());
    expect(section.querySelector('.tree-view-welcome')).toBeNull();
  } finally {
    slot.dispose();
  }
});

test('reports selection and expansion, and reveal expands the ancestors and selects the item', async () => {
  children.set(undefined, [
    { handle: 'a', label: 'A', collapsible: 1 },
    { handle: 'b', label: 'B', collapsible: 0 },
  ]);
  children.set('a', [{ handle: 'a1', label: 'A1', collapsible: 1 }]);
  children.set('a1', [{ handle: 'a2', label: 'A2', collapsible: 0 }]);
  await register({ canSelectMany: true });
  createPane();
  await vi.waitFor(() => expect(row('B')).toBeTruthy());
  row('B').click();
  expect(row('B').getAttribute('aria-selected')).toBe('true');
  row('A').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
  expect(calls.selection).toEqual([['b'], ['b', 'a']]);
  expect(row('A').getAttribute('aria-selected')).toBe('true');

  await views.reveal('tree', ['a', 'a1', 'a2'], { select: true, focus: true, expand: 0 });
  expect(rows().map(element => element.textContent)).toEqual(['A', 'A1', 'A2', 'B']);
  expect(row('A2').getAttribute('aria-selected')).toBe('true');
  expect(row('A').getAttribute('aria-selected')).toBe('false');
  expect(document.activeElement).toBe(row('A2'));
  expect(calls.selection.at(-1)).toEqual(['a2']);
  expect(calls.expanded).toEqual([['a', true], ['a1', true]]);

  section.querySelector<HTMLButtonElement>('button[aria-label="Collapse All"]')!.click();
  expect(rows().map(element => element.textContent)).toEqual(['A', 'B']);
});

test('the view header shows the title, description and badge the extension sets, and gets its title back', async () => {
  const trees = await register();
  const pane = createPane();
  await trees.$setTitle('a', 'tree', 'Renamed', 'Some details');
  await trees.$setBadge('a', 'tree', { value: 5, tooltip: 'Five things' });
  await trees.$setMessage('a', 'tree', 'Read <this>');
  const heading = section.querySelector('h3')!;
  expect(heading.textContent).toBe('Renamed');
  expect(section.getAttribute('aria-label')).toBe('Renamed');
  expect(section.querySelector('.tree-view-description')!.textContent).toBe('Some details');
  const badge = section.querySelector<HTMLElement>('.tree-view-badge')!;
  expect(badge.textContent).toBe('5');
  expect(badge.getAttribute('aria-label')).toBe('Five things');
  expect(section.querySelector('.tree-view-message')!.textContent).toBe('Read <this>');
  await trees.$setBadge('a', 'tree', { value: 0, tooltip: 'None' });
  expect(badge.hidden).toBe(true);
  pane.dispose();
  expect(heading.textContent).toBe('Original');
  expect(section.querySelector('.tree-view-badge')).toBeNull();
});
