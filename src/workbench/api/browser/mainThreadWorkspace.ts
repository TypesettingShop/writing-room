import type { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import type { WorkspaceFolderDto } from '../common/extHost.protocol.fileSystem.js';

export class MainThreadWorkspace {
  constructor(private readonly context: IWorkspaceContextService) {}

  get folders(): readonly WorkspaceFolderDto[] {
    return this.context.getWorkspace().folders.map(({ uri, name, index }) => ({ uri, name, index }));
  }
}
