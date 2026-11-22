import { expect, test, vi } from 'vitest';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { IManuscriptService } from '../../../../services/manuscript/common/manuscriptService.js';
import '../../browser/work.contribution.js';

test('reports a Welcome opening error separately after the account has signed out', async () => {
  const signOut = vi.fn().mockResolvedValue(undefined);
  const reportError = vi.fn();
  const failure = new Error('Welcome could not open.');
  const openEditor = vi.fn().mockRejectedValue(failure);
  const activeGroup = { editors: [], openEditor };
  const services = new Map<unknown, unknown>([
    [IManuscriptService, { auth: { signOut } }],
    [INotificationService, { error: reportError }],
    [IEditorGroupsService, { activeGroup, groups: [activeGroup] }],
  ]);
  const command = CommandsRegistry.getCommand('work.signOut')!;

  await expect(command.handler({ get: service => services.get(service) as never })).rejects.toBe(failure);
  expect(signOut).toHaveBeenCalledOnce();
  expect(openEditor).toHaveBeenCalledOnce();
  expect(reportError).not.toHaveBeenCalled();
});
