const vscode = require('vscode');

function check(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function rejects(operation, code, name) {
  try {
    await operation();
  } catch (error) {
    check(error instanceof vscode.FileSystemError && error.code === code,
      `Expected FileSystemError.${code}, got ${error.name}: ${error.message}`);
    if (name) {
      check(error.name === name, `Expected ${name}, got ${error.name}`);
    }
    return;
  }
  throw new Error(`Expected FileSystemError.${code}`);
}

exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('fixture.fileSystem.check', async () => {
    const { workspace, Uri, FileType, FilePermission } = vscode;
    const { fs } = workspace;
    const [folder] = workspace.workspaceFolders;
    check(workspace.workspaceFolders.length === 1 && folder.name === 'workspace' && folder.index === 0, 'Workspace folder');
    check(workspace.name === 'workspace' && workspace.workspaceFile === undefined && workspace.isTrusted, 'Workspace state');
    check(workspace.updateWorkspaceFolders(0, 1) === false, 'Workspace is fixed');
    const dir = Uri.joinPath(folder.uri, 'fs-check');
    const file = Uri.joinPath(dir, 'all-bytes');
    const missing = Uri.joinPath(dir, 'missing');
    const renamed = Uri.joinPath(dir, 'renamed');
    check(workspace.getWorkspaceFolder(file) === folder, 'Workspace membership');
    check(!workspace.getWorkspaceFolder(folder.uri.with({ path: '/workspace-sibling/x' })), 'Sibling path excluded');
    check(workspace.asRelativePath(file) === 'fs-check/all-bytes', 'Relative URI');
    check(workspace.asRelativePath(file.path, true) === 'workspace/fs-check/all-bytes', 'Relative string');
    check(workspace.asRelativePath('/other/file') === '/other/file', 'Outside path');
    check(fs.isWritableFileSystem(folder.uri.scheme) === true, 'Workspace is writable');
    check(fs.isWritableFileSystem('https') === false && fs.isWritableFileSystem('missing-scheme') === undefined, 'Capabilities');

    await fs.createDirectory(dir);
    check((await fs.stat(dir)).type === FileType.Directory, 'Directory stat');
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    await fs.writeFile(file, bytes);
    const result = await fs.readFile(file);
    check(result.length === 256 && result.every((value, index) => value === index && bytes[index] === index), 'Bytes');
    check((await fs.stat(file)).size === 256 && (await fs.readDirectory(dir))[0].join() === 'all-bytes,1', 'Directory listing');
    await rejects(() => fs.stat(missing), 'FileNotFound', 'EntryNotFound (FileSystemError)');
    await rejects(() => fs.readDirectory(file), 'FileNotADirectory');
    await rejects(() => fs.readFile(dir), 'FileIsADirectory');
    await fs.copy(file, renamed);
    await rejects(() => fs.rename(file, renamed), 'FileExists');
    await fs.rename(file, renamed, { overwrite: true });
    await rejects(() => fs.stat(file), 'FileNotFound');
    await fs.delete(renamed, { useTrash: true });

    const remote = Uri.joinPath(context.extensionUri, 'package.json');
    // Read an installed peer's package through the same provider and verify its read-only stat.
    const other = remote.with({ path: '/configuration-api/package.json' });
    const manifest = new TextDecoder().decode(await fs.readFile(other));
    check(manifest.includes('"publisher"') && (await fs.stat(other)).permissions === FilePermission.Readonly,
      'Installed peer package');
    await rejects(() => fs.readFile(remote.with({ path: '/configuration/package.json' })), 'NoPermissions');
    await rejects(() => fs.writeFile(remote, bytes), 'NoPermissions');

    const large = Uri.joinPath(dir, 'large');
    await fs.writeFile(large, new Uint8Array(50 * 1024 * 1024 + 1));
    await rejects(() => fs.readFile(large), 'Unknown', 'EntryTooLarge (FileSystemError)');
    await fs.delete(dir, { recursive: true });
    await vscode.window.showInformationMessage('File System API verified');
  }));
  context.subscriptions.push(
    vscode.commands.registerCommand('fixture.fileSystem.events', checkEventsAndSearch),
    vscode.commands.registerCommand('fixture.fileSystem.watchPeer', watchPeer),
    vscode.commands.registerCommand('fixture.fileSystem.writePeer', writePeer),
    vscode.commands.registerCommand('fixture.fileSystem.provider', checkProvider),
    vscode.commands.registerCommand('fixture.fileSystem.providerRemoved', checkProviderRemoved),
    vscode.commands.registerCommand('fixture.fileSystem.providerOpen', openProviderDocument),
  );
};

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (predicate() || Date.now() >= deadline) {
        clearInterval(timer);
        if (predicate()) {
          resolve();
        } else {
          reject(new Error('File events were not delivered.'));
        }
      }
    }, 20);
  });
}

async function checkEventsAndSearch() {
  const { workspace, Uri, RelativePattern, WorkspaceEdit, Position } = vscode;
  const { fs } = workspace;
  const dir = Uri.joinPath(workspace.workspaceFolders[0].uri, 'fs-events');
  const dotfile = Uri.joinPath(dir, '.markdownlint.json');
  const renamed = Uri.joinPath(dir, '.markdownlint.yml');
  const doc = await workspace.openTextDocument({ content: 'before' });
  const watcher = workspace.createFileSystemWatcher(new RelativePattern(dir, '**/.markdownlint.{json,yml}'));
  const ignore = workspace.createFileSystemWatcher('**/.markdownlint.{json,yml}', true, true, true);
  const changes = [];
  const operations = [];
  const ignored = [];
  const listeners = [
    watcher, ignore,
    watcher.onDidCreate(uri => changes.push(['create', uri.path])),
    watcher.onDidChange(uri => changes.push(['change', uri.path])),
    watcher.onDidDelete(uri => changes.push(['delete', uri.path])),
    ignore.onDidCreate(uri => ignored.push(uri)),
    ignore.onDidChange(uri => ignored.push(uri)),
    ignore.onDidDelete(uri => ignored.push(uri)),
    workspace.onWillRenameFiles(event => {
      operations.push(['will', event.files[0].oldUri.path, event.files[0].newUri.path]);
      event.waitUntil(Promise.resolve().then(() => {
        const edit = new WorkspaceEdit();
        edit.insert(doc.uri, new Position(0, 0), 'after ');
        return edit;
      }));
    }),
    workspace.onDidRenameFiles(event => operations.push(['did', event.files[0].oldUri.path, event.files[0].newUri.path])),
  ];
  try {
    await fs.writeFile(dotfile, Uint8Array.of(1));
    await fs.writeFile(dotfile, Uint8Array.of(2));
    await fs.writeFile(Uri.joinPath(dir, 'unrelated.txt'), new Uint8Array());
    // As in VS Code, operation events come from the Explorer and workspace edits, not from workspace.fs.
    const rename = new WorkspaceEdit();
    rename.renameFile(dotfile, renamed);
    check(await workspace.applyEdit(rename), 'Rename edit');
    await waitFor(() => changes.length >= 4 && operations.length >= 2);
    check(JSON.stringify(changes) === JSON.stringify([
      ['create', dotfile.path], ['change', dotfile.path], ['create', renamed.path], ['delete', dotfile.path],
    ]), 'Glob filtering and change order: ' + JSON.stringify(changes));
    check(JSON.stringify(operations) === JSON.stringify([
      ['will', dotfile.path, renamed.path], ['did', dotfile.path, renamed.path],
    ]), 'Rename event order');
    check(doc.getText() === 'after before', 'WorkspaceEdit was applied before rename');
    check(ignored.length === 0, 'Ignore flags');
    watcher.dispose();
    // The workspace.fs rename fires nothing. Events of the edit after it arrive after any it would send.
    await fs.rename(renamed, dotfile);
    const back = new WorkspaceEdit();
    back.renameFile(dotfile, renamed);
    check(await workspace.applyEdit(back), 'Second rename edit');
    await waitFor(() => operations.length >= 4);
    check(JSON.stringify(operations.slice(2)) === JSON.stringify([
      ['will', dotfile.path, renamed.path], ['did', dotfile.path, renamed.path],
    ]), 'workspace.fs rename fires no operation events: ' + JSON.stringify(operations));
    await fs.delete(renamed);

    await fs.writeFile(Uri.joinPath(dir, 'top.md'), new Uint8Array());
    await fs.writeFile(Uri.joinPath(dir, 'node_modules/nested.md'), new Uint8Array());
    const include = new RelativePattern(dir, '**/*.md');
    const defaults = await workspace.findFiles(include);
    const all = await workspace.findFiles(include, null);
    const explicit = await workspace.findFiles(include, '**/node_modules/**', 1);
    const token = new vscode.CancellationTokenSource();
    token.cancel();
    const cancelled = await workspace.findFiles(include, null, undefined, token.token);
    token.dispose();
    check(defaults.length === 1 && all.length === 2 && explicit.length === 1 && cancelled.length === 0,
      'Search filters, result cap and cancellation');
    check(changes.length === 4, 'Disposed watcher');
  } finally {
    vscode.Disposable.from(...listeners).dispose();
    await fs.delete(dir, { recursive: true });
  }
  await vscode.window.showInformationMessage('File events and search verified');
}

async function watchPeer() {
  const watcher = vscode.workspace.createFileSystemWatcher('**/peer-file.txt');
  let received = false;
  const listener = watcher.onDidCreate(() => { received = true; });
  try {
    void vscode.window.showInformationMessage('Watching other tab');
    await waitFor(() => received);
    await vscode.window.showInformationMessage('Other tab event verified');
  } finally {
    listener.dispose();
    watcher.dispose();
  }
}

async function writePeer() {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'peer-file.txt');
  await vscode.workspace.fs.writeFile(uri, Uint8Array.of(1));
  await vscode.window.showInformationMessage('Other tab write verified');
}

const providerText = 'memfs says hello';

async function checkProvider() {
  const { workspace, Uri, RelativePattern } = vscode;
  const { fs } = workspace;
  const root = Uri.parse('memfs:/');
  const welcome = Uri.joinPath(root, 'welcome.txt');
  const bytes = await fs.readFile(welcome);
  check(new TextDecoder().decode(bytes) === providerText, 'Provider activation and read');
  bytes.fill(0);
  check(new TextDecoder().decode(await fs.readFile(welcome)) === providerText, 'Read does not detach provider storage');
  check(fs.isWritableFileSystem('memfs') && fs.isWritableFileSystem('memfs-readonly') === false, 'Provider capabilities');

  for (const [scheme, expected] of [['VSCODE-VFS', 'reserved'], ['data', 'reserved'],
    ['vscode-webview', 'reserved'], ['MemFs', 'already registered'], ['aa b', 'Invalid URI scheme']]) {
    try {
      workspace.registerFileSystemProvider(scheme, {});
      throw new Error('Provider registration unexpectedly succeeded');
    } catch (error) {
      check(error.message.includes(expected), 'Provider scheme validation: ' + error.message);
    }
  }
  const readonly = Uri.parse('memfs-readonly:/welcome.txt');
  check((await fs.stat(readonly)).permissions === vscode.FilePermission.Readonly, 'Readonly stat');
  await rejects(() => fs.writeFile(readonly, bytes), 'NoPermissions');

  const created = [];
  const count = Uri.joinPath(root, 'watch-count');
  const watch = workspace.createFileSystemWatcher(new RelativePattern(root, '*.txt'));
  const listener = watch.onDidCreate(uri => created.push(uri.path));
  const path = Uri.joinPath(root, 'provider.txt');
  const renamed = Uri.joinPath(root, 'provider-renamed.txt');
  try {
    check((await fs.readFile(count))[0] === 1, 'Provider watch registered');
    await fs.writeFile(path, Uint8Array.of(0, 255));
    await fs.rename(path, renamed);
    await waitFor(() => created.includes(renamed.path));
    check((await fs.readFile(renamed)).join() === '0,255', 'Provider write and rename');
    check((await fs.readDirectory(root)).some(([name]) => name === 'provider-renamed.txt'), 'Provider listing');
    await rejects(() => fs.stat(path), 'FileNotFound');
    await fs.delete(renamed);
    await rejects(() => fs.stat(renamed), 'FileNotFound');
  } finally {
    listener.dispose();
    watch.dispose();
  }
  check((await fs.readFile(count))[0] === 0, 'Provider watch disposed');
  await vscode.window.showInformationMessage('File System Provider verified');
}

async function checkProviderRemoved() {
  // The uninstall keeps running after its quick pick closes, so wait for the provider to go away.
  const deadline = Date.now() + 5000;
  for (;;) {
    let rejected = false;
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.parse('memfs:/welcome.txt'));
    } catch (error) {
      rejected = error instanceof vscode.FileSystemError && ['Unavailable', 'NoPermissions'].includes(error.code);
    }
    if (rejected && vscode.workspace.fs.isWritableFileSystem('memfs') === undefined) {
      break;
    }
    check(Date.now() < deadline, 'Removed provider is unavailable');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await vscode.window.showInformationMessage('Removed File System Provider verified');
}

async function openProviderDocument() {
  const uri = vscode.Uri.parse('memfs:/welcome.txt');
  check(vscode.workspace.fs.isWritableFileSystem(uri.scheme) === undefined, 'Provider is inactive before opening');
  const document = await vscode.workspace.openTextDocument(uri);
  check(document.getText() === providerText, 'Provider document text');
  await vscode.commands.executeCommand('vscode.open', uri);
}
