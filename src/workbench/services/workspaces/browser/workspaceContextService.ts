import { Event } from '../../../../base/common/event.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEqualOrParent } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { normalizeFileResource, workspaceAuthority } from '../../../../platform/files/common/fileResource.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import type { IWorkspace, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkService, WorkOpenContext } from '../../work/common/work.js';

const workbenchState = new RawContextKey('workbenchState', 'folder');
const folderCount = new RawContextKey('workspaceFolderCount', 1);
const workspaceUri = URI.from({ scheme: Schemas.vscodeVfs, authority: workspaceAuthority, path: '/workspace' });

const folder: IWorkspaceFolder = Object.freeze({
  uri: workspaceUri,
  name: 'workspace',
  index: 0,
  toResource: (relativePath: string) => URI.joinPath(workspaceUri, relativePath),
});

const folders = Object.freeze([folder]);

export class WorkspaceContextService implements IWorkspaceContextService {
  declare readonly _serviceBrand: undefined;
  readonly onDidChangeWorkspaceFolders = Event.None;
  private readonly workspace: IWorkspace;

  constructor(@IContextKeyService context: IContextKeyService, @IWorkService work: IWorkService) {
    const current = work.current;
    this.workspace = Object.freeze({ id: current ? `work-${current.id}` : 'writing-room', folders });
    workbenchState.bindTo(context);
    folderCount.bindTo(context);
    WorkOpenContext.bindTo(context).set(current !== undefined);
  }

  getWorkbenchState(): WorkbenchState {
    return WorkbenchState.FOLDER;
  }

  getWorkspace(): IWorkspace {
    return this.workspace;
  }

  getWorkspaceFolder(resource: URI): IWorkspaceFolder | null {
    if (resource.scheme !== Schemas.vscodeVfs) {
      return null;
    }
    try {
      return isEqualOrParent(normalizeFileResource(resource), workspaceUri) ? folder : null;
    } catch {
      return null;
    }
  }
}

/** Start storage preparation after the workbench has mounted, without holding up the first paint. */
export class WorkspaceStorageContribution {
  constructor(@IFileService files: IFileService, @IWorkspaceContextService context: IWorkspaceContextService) {
    void files.createFolder(context.getWorkspace().folders[0].uri).catch(console.error);
  }
}
