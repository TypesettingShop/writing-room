import { describe, expect, test } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { ExtensionFileAccess } from '../../browser/extensionFileAccess.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';

const folder = URI.parse('vscode-vfs://writing-room/workspace');
const owner: HostExtensionDescription = {
  id: 'fixture.owner', key: 'owner', location: 'https://example.test/owner/', entry: '', activationEvents: [],
  manifest: { name: 'owner', publisher: 'fixture', version: '1.0.0', engines: { vscode: '*' } },
};
const access = new ExtensionFileAccess(
  { id: 'writing-room', folders: [{ uri: folder, name: 'workspace', index: 0, toResource: path => URI.joinPath(folder, path) }] },
  () => [owner.location, 'vscode-userdata:/extensions/fixture.peer-1.0.0/'],
  scheme => scheme === 'registered',
);

describe('extension file access', () => {
  test.each([
    ['vscode-vfs://writing-room/workspace/dir/../file', 'vscode-vfs://writing-room/workspace/file'],
    ['vscode-userdata:/User/globalStorage/fixture.owner/test', 'vscode-userdata:/User/globalStorage/fixture.owner/test'],
    ['vscode-userdata:/User/workspaceStorage/writing-room/fixture.owner/test',
      'vscode-userdata:/User/workspaceStorage/writing-room/fixture.owner/test'],
    ['registered:/file', 'registered:/file'],
  ])('normalizes writable URIs %s', (input, expected) => {
    expect(access.require(owner, URI.parse(input), true).toString()).toBe(expected);
  });

  test.each([
    'vscode-vfs://writing-room/workspace/../../outside',
    'vscode-vfs://writing-room/workspace/%2e%2e/outside',
    'vscode-vfs://writing-room/workspace/%2foutside',
    'vscode-vfs://writing-room/workspace/%00control',
    'vscode-vfs://other/workspace/file',
    'VSCODE-VFS://writing-room/workspace/file',
    'vscode-vfs://writing-room/workspace-sibling/file',
    'vscode-userdata:/extensions/fixture.peer-1.0.0/file',
    'vscode-userdata:/User/globalStorage/fixture.peer/file',
    'vscode-userdata:/User/workspaceStorage/writing-room/fixture.peer/file',
    'vscode-userdata:/User/settings.json',
    'vscode-userdata:/User/other',
  ])('refuses writes to %s', input => {
    expect(() => access.require(owner, URI.parse(input), true)).toThrow(expect.objectContaining({ code: 'NoPermissions' }));
  });

  test.each([
    'https://example.test/owner/package.json',
    'vscode-userdata:/extensions/fixture.peer-1.0.0/package.json',
  ])('allows reads under an installed package %s', input => {
    expect(access.require(owner, URI.parse(input), false).path.endsWith('/package.json')).toBe(true);
  });

  test.each([
    'https://example.test/another/package.json',
    'https://other.test/owner/package.json',
    'vscode-userdata:/extensions/fixture.uninstalled-1.0.0/file',
    'vscode-userdata:/User/globalStorage/fixture.peer/file',
  ])('refuses reads of %s', input => {
    expect(() => access.require(owner, URI.parse(input), false)).toThrow(expect.objectContaining({ code: 'NoPermissions' }));
  });
});

test('reads only current installed roots after the package list changes', () => {
  const locations = ['vscode-userdata:/extensions/fixture.peer-1.0.0/'];
  const access = new ExtensionFileAccess({ id: 'writing-room', folders: [] }, () => locations, () => false);
  const oldResource = URI.parse(locations[0] + 'package.json');
  expect(access.isAllowed(owner, oldResource, false)).toBe(true);

  locations[0] = 'vscode-userdata:/extensions/fixture.peer-1.1.0/';
  expect(access.isAllowed(owner, oldResource, false)).toBe(false);
  expect(access.isAllowed(owner, URI.parse(locations[0] + 'package.json'), false)).toBe(true);
});
