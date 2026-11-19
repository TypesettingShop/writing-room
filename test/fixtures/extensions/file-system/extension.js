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
};
