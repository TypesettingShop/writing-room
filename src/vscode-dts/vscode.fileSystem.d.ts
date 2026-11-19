declare module 'vscode' {
  export enum FileType {
    Unknown = 0,
    File = 1,
    Directory = 2,
    SymbolicLink = 64,
  }

  export enum FilePermission {
    Readonly = 1,
  }

  export interface FileStat {
    type: FileType;
    ctime: number;
    mtime: number;
    size: number;
    permissions?: FilePermission;
  }

  export class FileSystemError extends Error {
    constructor(messageOrUri?: string | Uri);
    readonly code: string;
    static FileNotFound(messageOrUri?: string | Uri): FileSystemError;
    static FileExists(messageOrUri?: string | Uri): FileSystemError;
    static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError;
    static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError;
    static NoPermissions(messageOrUri?: string | Uri): FileSystemError;
    static Unavailable(messageOrUri?: string | Uri): FileSystemError;
  }

  export interface FileSystem {
    stat(uri: Uri): Thenable<FileStat>;
    readDirectory(uri: Uri): Thenable<[string, FileType][]>;
    createDirectory(uri: Uri): Thenable<void>;
    readFile(uri: Uri): Thenable<Uint8Array>;
    writeFile(uri: Uri, content: Uint8Array): Thenable<void>;
    delete(uri: Uri, options?: { recursive?: boolean; useTrash?: boolean }): Thenable<void>;
    rename(source: Uri, target: Uri, options?: { overwrite?: boolean }): Thenable<void>;
    copy(source: Uri, target: Uri, options?: { overwrite?: boolean }): Thenable<void>;
    isWritableFileSystem(scheme: string): boolean | undefined;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export interface WorkspaceFoldersChangeEvent {
    readonly added: readonly WorkspaceFolder[];
    readonly removed: readonly WorkspaceFolder[];
  }

  export type GlobPattern = string | RelativePattern;

  export interface FileSystemWatcher extends Disposable {
    readonly ignoreCreateEvents: boolean;
    readonly ignoreChangeEvents: boolean;
    readonly ignoreDeleteEvents: boolean;
    readonly onDidCreate: Event<Uri>;
    readonly onDidChange: Event<Uri>;
    readonly onDidDelete: Event<Uri>;
  }

  export interface FileCreateEvent {
    readonly files: readonly Uri[];
  }

  export interface FileDeleteEvent {
    readonly files: readonly Uri[];
  }

  export interface FileRenameEvent {
    readonly files: ReadonlyArray<{ readonly oldUri: Uri; readonly newUri: Uri }>;
  }

  export interface FileWillCreateEvent {
    readonly token: CancellationToken;
    readonly files: readonly Uri[];
    waitUntil(thenable: Thenable<WorkspaceEdit>): void;
    waitUntil(thenable: Thenable<any>): void;
  }

  export interface FileWillDeleteEvent {
    readonly token: CancellationToken;
    readonly files: readonly Uri[];
    waitUntil(thenable: Thenable<WorkspaceEdit>): void;
    waitUntil(thenable: Thenable<any>): void;
  }

  export interface FileWillRenameEvent {
    readonly token: CancellationToken;
    readonly files: ReadonlyArray<{ readonly oldUri: Uri; readonly newUri: Uri }>;
    waitUntil(thenable: Thenable<WorkspaceEdit>): void;
    waitUntil(thenable: Thenable<any>): void;
  }

  export namespace workspace {
    export const fs: FileSystem;
    export const onWillCreateFiles: Event<FileWillCreateEvent>;
    export const onDidCreateFiles: Event<FileCreateEvent>;
    export const onWillDeleteFiles: Event<FileWillDeleteEvent>;
    export const onDidDeleteFiles: Event<FileDeleteEvent>;
    export const onWillRenameFiles: Event<FileWillRenameEvent>;
    export const onDidRenameFiles: Event<FileRenameEvent>;
    export function createFileSystemWatcher(globPattern: GlobPattern, ignoreCreateEvents?: boolean,
      ignoreChangeEvents?: boolean, ignoreDeleteEvents?: boolean): FileSystemWatcher;
    export function findFiles(include: GlobPattern, exclude?: GlobPattern | null, maxResults?: number,
      token?: CancellationToken): Thenable<Uri[]>;
    export const workspaceFolders: readonly WorkspaceFolder[] | undefined;
    export const name: string | undefined;
    export const workspaceFile: Uri | undefined;
    export const isTrusted: boolean;
    export const onDidGrantWorkspaceTrust: Event<void>;
    export const onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent>;
    export function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
    export function asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string;
    export function updateWorkspaceFolders(start: number, deleteCount: number | undefined | null, ...workspaceFoldersToAdd: {
      readonly uri: Uri;
      readonly name?: string;
    }[]): boolean;
  }
}
