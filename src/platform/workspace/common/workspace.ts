import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export enum WorkbenchState { EMPTY = 1, FOLDER = 2, WORKSPACE = 3 }

export interface IWorkspaceFolder {
  readonly uri: URI;
  readonly name: string;
  readonly index: number;
  toResource(relativePath: string): URI;
}

export interface IWorkspace {
  readonly id: string;
  readonly folders: readonly IWorkspaceFolder[];
}

export interface IWorkspaceFoldersChangeEvent {
  readonly added: readonly IWorkspaceFolder[];
  readonly removed: readonly IWorkspaceFolder[];
  readonly changed: readonly IWorkspaceFolder[];
}

export const IWorkspaceContextService = createDecorator<IWorkspaceContextService>('workspaceContextService');

export interface IWorkspaceContextService {
  readonly _serviceBrand: undefined;
  readonly onDidChangeWorkspaceFolders: Event<IWorkspaceFoldersChangeEvent>;
  getWorkbenchState(): WorkbenchState;
  getWorkspace(): IWorkspace;
  getWorkspaceFolder(resource: URI): IWorkspaceFolder | null;
}
