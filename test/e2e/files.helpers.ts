import type { Locator, Page } from '@playwright/test';
import { expect, renderedText } from './fixtures.js';

/** Where the workbench keeps its editor part state (workspace scope). */
const editorStateKey = 'writing-room:storage:1:memento/workbench.parts.editor';
const database = 'writing-room-files';
const store = 'vscode-vfs';
const workspaceRoot = 'vscode-vfs://writing-room/workspace';

export const FILE_EDITOR_INPUT_ID = 'workbench.editors.files.fileEditorInput';

export const groups = (page: Page) => page.locator('[data-group-id]');
export const selectedTab = (scope: Locator) => scope.getByRole('tab', { selected: true });

/** The workspace URI of `path`, relative to the workspace folder. */
export function workspaceUri(path: string): string {
  return workspaceRoot + '/' + path.split('/').map(encodeURIComponent).join('/');
}

/** Waits until the workbench has made its file storage and the workspace folder in it. */
export async function waitForStorage(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async ({ database, store }) => {
    if (!(await indexedDB.databases()).some(entry => entry.name === database)) {
      return false;
    }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains(store)) {
        return false;
      }
      const entry = await new Promise(resolve => {
        const request = db.transaction(store).objectStore(store).get('/workspace');
        request.onsuccess = () => resolve(request.result);
      });
      return entry !== undefined;
    } finally {
      db.close();
    }
  }, { database, store }), { timeout: 20_000 }).toBe(true);
}

type StoredContent = string | { readonly bytes: readonly number[] } | { readonly repeat: string; readonly count: number };

/**
 * Changes the workspace as another tab of the same storage does: a raw IndexedDB write (or deletion)
 * in the storage's record format, then the change message on the storage's channel, which this
 * page's provider takes as an outside change.
 */
async function changeStorage(page: Page, change: { path: string; content?: StoredContent; folders?: string[] }): Promise<void> {
  await page.evaluate(async ({ database, store, change }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const key = '/workspace/' + change.path;
    const changes: { path: string; type: number }[] = [];
    try {
      const transaction = db.transaction(store, 'readwrite');
      const objects = transaction.objectStore(store);
      const existing = await new Promise<{ mtime: number; ctime: number } | undefined>(resolve => {
        const request = objects.get(key);
        request.onsuccess = () => resolve(request.result);
      });
      const now = Math.max(Date.now(), (existing?.mtime ?? 0) + 1);
      for (const folder of change.folders ?? []) {
        objects.put({ type: 2, ctime: now, mtime: now, size: 0 }, '/workspace/' + folder);
        changes.push({ path: '/workspace/' + folder, type: 1 });
      }
      if (change.content === undefined) {
        objects.delete(key);
        changes.push({ path: key, type: 2 });
      } else {
        const content = change.content;
        const blob = typeof content === 'string' ? new Blob([new TextEncoder().encode(content)])
          : 'bytes' in content ? new Blob([new Uint8Array(content.bytes)])
            : new Blob([content.repeat.repeat(content.count)]);
        objects.put({ type: 1, ctime: existing?.ctime ?? now, mtime: now, size: blob.size, bytes: blob }, key);
        changes.push({ path: key, type: existing ? 0 : 1 });
      }
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
    const channel = new BroadcastChannel(database + '/' + store);
    channel.postMessage({ version: 1, changes });
    channel.close();
  }, { database, store, change });
}

/** Writes a workspace file from outside the page's file service, creating `folders` first. */
export function writeWorkspaceFile(page: Page, path: string, content: StoredContent, folders: string[] = []): Promise<void> {
  return changeStorage(page, { path, content, folders });
}

/** Deletes a workspace file from outside the page's file service. */
export function deleteWorkspaceFile(page: Page, path: string): Promise<void> {
  return changeStorage(page, { path });
}

/** The stored bytes of a workspace file, or `undefined` when there is none. */
export function readWorkspaceBytes(page: Page, path: string): Promise<number[] | undefined> {
  return page.evaluate(async ({ database, store, key }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const entry = await new Promise<{ bytes?: Blob } | undefined>(resolve => {
        const request = db.transaction(store).objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result);
      });
      return entry?.bytes ? Array.from(new Uint8Array(await entry.bytes.arrayBuffer())) : undefined;
    } finally {
      db.close();
    }
  }, { database, store, key: '/workspace/' + path });
}

export async function readWorkspaceText(page: Page, path: string): Promise<string | undefined> {
  const bytes = await readWorkspaceBytes(page, path);
  return bytes && new TextDecoder().decode(new Uint8Array(bytes));
}

/** The draft backups in the workspace storage. */
export function listBackups(page: Page): Promise<string[]> {
  return page.evaluate(async ({ database }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(database);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const keys = await new Promise<IDBValidKey[]>(resolve => {
        const request = db.transaction('vscode-userdata').objectStore('vscode-userdata').getAllKeys();
        request.onsuccess = () => resolve(request.result);
      });
      return keys.filter((key): key is string => typeof key === 'string' && /^\/User\/workspaceStorage\/[^/]+\/backups\/[^/]+$/.test(key));
    } finally {
      db.close();
    }
  }, { database });
}

/**
 * Opens `resources` (workspace paths, or whole URIs) as file editors of the first group, the first
 * one active, the way the workbench restores them: the page reloads with them in its saved state.
 */
export async function openFilesByRestore(page: Page, resources: readonly string[]): Promise<void> {
  const editors = resources.map(resource => ({
    id: FILE_EDITOR_INPUT_ID,
    value: JSON.stringify({ resource: resource.includes(':') ? resource : workspaceUri(resource) }),
  }));
  const marker = `files-spec-restore-${Math.random()}`;
  await page.addInitScript(({ key, editors, marker }) => {
    // Once: later reloads of the test keep what the workbench saved itself.
    if (sessionStorage.getItem(marker)) {
      return;
    }
    sessionStorage.setItem(marker, '1');
    const stored = localStorage.getItem(key);
    const data = stored ? JSON.parse(stored) : undefined;
    let node = data?.['editorpart.state']?.serializedGrid?.root;
    while (node?.type === 'branch') {
      node = node.data[0];
    }
    if (node?.type === 'leaf') {
      node.data.editors = editors;
      node.data.mru = editors.map((_: unknown, index: number) => index);
      localStorage.setItem(key, JSON.stringify(data));
    }
  }, { key: editorStateKey, editors, marker });
  await page.reload();
  await expect(selectedTab(groups(page).first())).toBeVisible({ timeout: 20_000 });
}

/** The text the active editor of `group` shows, once it is `expected`. */
export async function expectEditorText(group: Locator, expected: string): Promise<void> {
  await expect.poll(() => renderedText(group), { timeout: 20_000 }).toBe(expected);
}

/** Puts the cursor at the end of the active editor of `group`. */
export async function focusEditorEnd(page: Page, group: Locator): Promise<void> {
  await group.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('ControlOrMeta+End');
}

/** The quick pick asking `title`, once it has focus. */
export function quickPick(page: Page, title: string | RegExp): Locator {
  return page.getByRole('combobox', { name: title });
}

/** The quick input box (no list) asking `title`. */
export function quickInputBox(page: Page, title: string | RegExp): Locator {
  return page.getByRole('textbox', { name: title });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clicks the quick pick option whose name starts with `label`. */
export async function chooseOption(page: Page, label: string): Promise<void> {
  await page.getByRole('listbox', { name: 'Results' }).getByRole('option', { name: new RegExp('^' + escapeRegExp(label)) }).click();
}

/** Answers the question asked before a dirty editor named `name` closes. */
export async function answerCloseQuestion(page: Page, name: string, answer: 'Save' | "Don't Save" | 'Cancel'): Promise<void> {
  await expect(quickPick(page, `Do you want to save the changes you made to ${name}?`)).toBeFocused();
  await chooseOption(page, answer);
}

/** Runs a File menu item. */
export async function fileMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: item, exact: true }).click();
}
