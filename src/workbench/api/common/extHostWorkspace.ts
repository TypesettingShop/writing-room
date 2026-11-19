import type * as vscode from 'vscode';
import { Event } from '../../../base/common/event.js';
import { normalize, relative } from '../../../base/common/path.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import type { WorkspaceFolderDto } from './extHost.protocol.fileSystem.js';

export class ExtHostWorkspace {
  folders: readonly WorkspaceFolderDto[] = [];

  initialize(folders: readonly WorkspaceFolderDto[]): void {
    this.folders = Object.freeze(folders.map(folder => {
      Object.freeze(folder.uri);
      return Object.freeze(folder);
    }));
  }

  private getWorkspaceFolder(uri: vscode.Uri): WorkspaceFolderDto | undefined {
    if (!URI.isUri(uri) || uri.hasEncodedPathSeparator || !uri.path.startsWith('/')) {
      return undefined;
    }
    const normalized = uri.with({ path: normalize(uri.path) });
    return this.folders.find(folder => normalized.authority === folder.uri.authority
      && isEqualOrParent(normalized, folder.uri));
  }

  private asRelativePath(input: string | vscode.Uri, includeWorkspaceFolder = this.folders.length > 1): string {
    const path = typeof input === 'string' ? input : input.fsPath;
    const first = this.folders[0];
    if (typeof input === 'string' && (!first || !input.startsWith('/'))) {
      return path;
    }
    const resource = typeof input === 'string' ? first.uri.with({ path: input }) : input;
    const folder = this.getWorkspaceFolder(resource);
    if (!folder) {
      return path;
    }
    const localPath = relative(folder.uri.path, resource.path);
    return includeWorkspaceFolder ? (localPath ? folder.name + '/' + localPath : folder.name) : localPath;
  }

  createApi() {
    const workspace = this;
    return {
      get workspaceFolders() { return workspace.folders; },
      get name() { return workspace.folders[0]?.name; },
      workspaceFile: undefined,
      isTrusted: true,
      onDidGrantWorkspaceTrust: Event.None,
      onDidChangeWorkspaceFolders: Event.None,
      getWorkspaceFolder: (uri: vscode.Uri) => this.getWorkspaceFolder(uri),
      asRelativePath: (pathOrUri: string | vscode.Uri, includeWorkspaceFolder?: boolean) =>
        this.asRelativePath(pathOrUri, includeWorkspaceFolder),
      updateWorkspaceFolders: () => false,
    } satisfies Pick<typeof vscode.workspace, 'workspaceFolders' | 'name' | 'workspaceFile' | 'isTrusted'
      | 'onDidGrantWorkspaceTrust' | 'onDidChangeWorkspaceFolders' | 'getWorkspaceFolder' | 'asRelativePath'
      | 'updateWorkspaceFolders'>;
  }
}
