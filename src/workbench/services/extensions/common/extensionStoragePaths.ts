import { URI } from '../../../../base/common/uri.js';

function storageSegment(value: string): string {
  if (!/^[a-z\d_.-]+$/i.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid extension storage path segment '${value}'.`);
  }
  return value.toLowerCase();
}

export function extensionGlobalStorageUri(extensionId: string): URI {
  return URI.from({
    scheme: 'vscode-userdata',
    path: '/User/globalStorage/' + storageSegment(extensionId),
  });
}

export function extensionWorkspaceStorageUri(workspaceId: string, extensionId: string): URI {
  return URI.from({
    scheme: 'vscode-userdata',
    path: '/User/workspaceStorage/' + storageSegment(workspaceId) + '/' + storageSegment(extensionId),
  });
}

export function extensionLogUri(extensionId: string): URI {
  return URI.from({ scheme: 'vscode-userdata', path: '/logs/' + storageSegment(extensionId) });
}
