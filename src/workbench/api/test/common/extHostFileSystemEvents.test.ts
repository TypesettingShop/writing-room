import { expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import type { MainThreadFileSystemShape } from '../../common/extHost.protocol.fileSystem.js';
import { RelativePattern } from '../../common/extHostCommonTypes.js';
import { ExtHostFileSystemEventService } from '../../common/extHostFileSystemEventService.js';
import { WorkspaceEdit } from '../../common/extHostTypes.js';
import { ExtHostWorkspace } from '../../common/extHostWorkspace.js';

const root = URI.parse('vscode-vfs://writing-room/workspace');

test('participant edits of different extensions apply one at a time', async () => {
  const steps: string[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const events = new ExtHostFileSystemEventService({ async $subscribeFileOperation() {} } as unknown as MainThreadFileSystemShape,
    () => [], async key => {
      steps.push('start ' + key);
      if (key === 'first') {
        await held;
      }
      steps.push('end ' + key);
      return true;
    });
  for (const key of ['first', 'second']) {
    events.createApi(key).onWillRenameFiles(event => event.waitUntil(Promise.resolve(new WorkspaceEdit())));
  }
  const participating = events.$participateInFileOperation(['first', 'second'],
    { kind: 'rename', resource: URI.joinPath(root, 'a'), target: URI.joinPath(root, 'b') });
  await vi.waitFor(() => expect(steps).toEqual(['start first']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(steps).toEqual(['start first']);
  release();
  await participating;
  expect(steps).toEqual(['start first', 'end first', 'start second', 'end second']);
});

test('a relative pattern whose base has an authority and no path watches its root', () => {
  const watch = vi.fn<MainThreadFileSystemShape['$watch']>().mockResolvedValue(undefined);
  const events = new ExtHostFileSystemEventService({ $watch: watch, async $unwatch() {} } as unknown as MainThreadFileSystemShape,
    () => [], async () => true);
  const watcher = events.createApi('owner').createFileSystemWatcher(new RelativePattern(URI.parse('memfs://host'), '**'));
  expect(watch.mock.calls[0][2]?.toString()).toBe('memfs://host/');
  watcher.dispose();
});

test('workspaceFolders is undefined without a folder, as in VS Code', () => {
  const workspace = new ExtHostWorkspace();
  expect(workspace.createApi().workspaceFolders).toBeUndefined();
  workspace.initialize([{ uri: root, name: 'workspace', index: 0 }]);
  expect(workspace.createApi().workspaceFolders?.map(folder => folder.name)).toEqual(['workspace']);
});
