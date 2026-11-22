const vscode = require('vscode');
const { FileChangeType, FileSystemError, FileType } = vscode;

class MemFs {
  constructor() {
    this.events = new vscode.EventEmitter();
    this.onDidChangeFile = this.events.event;
    this.watches = 0;
    this.entries = new Map([
      ['/', null],
      ['/welcome.txt', new TextEncoder().encode('memfs says hello')],
    ]);
  }

  watch() {
    this.watches++;
    return new vscode.Disposable(() => this.watches--);
  }

  entry(uri) {
    if (uri.path === '/watch-count') {
      return Uint8Array.of(this.watches);
    }
    if (!this.entries.has(uri.path)) {
      throw FileSystemError.FileNotFound(uri);
    }
    return this.entries.get(uri.path);
  }

  stat(uri) {
    const bytes = this.entry(uri);
    return { type: bytes === null ? FileType.Directory : FileType.File, ctime: 0, mtime: 0, size: bytes?.length ?? 0 };
  }

  readDirectory(uri) {
    if (this.entry(uri) !== null) {
      throw FileSystemError.FileNotADirectory(uri);
    }
    const prefix = uri.path === '/' ? '/' : uri.path + '/';
    return [...this.entries].filter(([key]) => key.startsWith(prefix) && key.length > prefix.length
      && !key.slice(prefix.length).includes('/'))
      .map(([key, bytes]) => [key.slice(prefix.length), bytes === null ? FileType.Directory : FileType.File]);
  }

  createDirectory(uri) {
    this.entries.set(uri.path, null);
    this.events.fire([{ type: FileChangeType.Created, uri }]);
  }

  readFile(uri) {
    const bytes = this.entry(uri);
    if (bytes === null) {
      throw FileSystemError.FileIsADirectory(uri);
    }
    return bytes;
  }

  writeFile(uri, content, options) {
    const exists = this.entries.has(uri.path);
    if (exists && !options.overwrite) {
      throw FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw FileSystemError.FileNotFound(uri);
    }
    this.entries.set(uri.path, content);
    this.events.fire([{ type: exists ? FileChangeType.Changed : FileChangeType.Created, uri }]);
  }

  delete(uri) {
    this.entry(uri);
    this.entries.delete(uri.path);
    this.events.fire([{ type: FileChangeType.Deleted, uri }]);
  }

  rename(from, to, options) {
    const value = this.entry(from);
    if (this.entries.has(to.path) && !options.overwrite) {
      throw FileSystemError.FileExists(to);
    }
    this.entries.delete(from.path);
    this.entries.set(to.path, value);
    this.events.fire([
      { type: FileChangeType.Deleted, uri: from },
      { type: FileChangeType.Created, uri: to },
    ]);
  }
}

exports.activate = context => {
  const provider = new MemFs();
  const readonly = new MemFs();
  readonly.entries.set('/welcome.md', new TextEncoder().encode('Read-only Markdown'));
  readonly.entries.set('/lines.md', new TextEncoder().encode(
    Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n\n')));
  context.subscriptions.push(provider.events, readonly.events,
    vscode.workspace.registerFileSystemProvider('memfs', provider, { isCaseSensitive: true }),
    vscode.workspace.registerFileSystemProvider('memfs-readonly', readonly, { isReadonly: true }),
    vscode.commands.registerCommand('fixture.memfs.openReadOnlyMarkdown', () =>
      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('memfs-readonly:/welcome.md'))),
    vscode.commands.registerCommand('fixture.memfs.openReadOnlyTypewriter', () =>
      vscode.commands.executeCommand('vscode.open', vscode.Uri.parse('memfs-readonly:/lines.md'))),
  );
};
