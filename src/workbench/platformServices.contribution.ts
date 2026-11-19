import '../platform/actions/common/menuService.js';
import '../platform/contextkey/browser/contextKeyService.js';
import '../platform/contextview/browser/contextMenuService.js';
import './services/commands/common/commandService.js';
import './services/keybinding/browser/keybindingService.js';
import './services/storage/browser/storageService.js';

import { IFileService } from '../platform/files/common/files.js';
import { registerSingleton } from '../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../platform/workspace/common/workspace.js';
import { registerWorkbenchContribution2 } from './common/contributions.js';
import { BrowserFileService } from './services/workspaces/browser/browserFileService.js';
import { WorkspaceContextService, WorkspaceStorageContribution } from './services/workspaces/browser/workspaceContextService.js';

registerSingleton(IFileService, BrowserFileService);
registerSingleton(IWorkspaceContextService, WorkspaceContextService);
registerWorkbenchContribution2('workbench.contrib.workspaceStorage', WorkspaceStorageContribution);
