import { expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../browser/workspaceContextService.js';

test('publishes the folder and its context keys without opening storage', () => {
  const context = new ContextKeyService();
  try {
    const service = new WorkspaceContextService(context);
    const { id, folders } = service.getWorkspace();
    expect(id).toBe('writing-room');
    expect(folders).toHaveLength(1);
    const [folder] = folders;
    expect([folder.name, folder.index, folder.uri.toString()]).toEqual([
      'workspace', 0, 'vscode-vfs://writing-room/workspace',
    ]);
    expect(service.getWorkbenchState()).toBe(WorkbenchState.FOLDER);
    expect(context.contextMatchesRules(ContextKeyExpr.deserialize('workbenchState == folder'))).toBe(true);
    expect(context.getContextKeyValue('workspaceFolderCount')).toBe(1);
    expect(service.getWorkspaceFolder(folder.uri)).toBe(folder);
    expect(service.getWorkspaceFolder(folder.toResource('draft/../readme.md'))).toBe(folder);
    for (const outside of [
      'vscode-vfs://writing-room/workspace-old/x',
      'vscode-vfs://writing-room/workspace/../outside',
      'vscode-vfs://writing-room/workspace%2Ffile',
      'vscode-vfs://other/workspace/file',
      'vscode-userdata:/workspace/file',
    ]) {
      expect(service.getWorkspaceFolder(URI.parse(outside))).toBeNull();
    }
  } finally {
    context.dispose();
  }
});
