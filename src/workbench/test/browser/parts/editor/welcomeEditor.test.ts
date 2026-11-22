import { expect, test, vi } from 'vitest';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ManuscriptStoreError, type ManuscriptWork } from '../../../../../platform/manuscript/common/manuscript.js';
import { WelcomeEditorInput, WelcomeEditorPane } from '../../../../browser/parts/editor/welcomeEditor.js';
import type { IManuscriptService, ManuscriptAvailability } from '../../../../services/manuscript/common/manuscriptService.js';
import type { IWorkService } from '../../../../services/work/common/work.js';

function welcome(listWorks: () => Promise<ManuscriptWork[]>, availability: ManuscriptAvailability) {
  const parent = document.createElement('div');
  const commands = { executeCommand: vi.fn() } as unknown as ICommandService;
  const manuscript = { store: { listWorks }, availability } as IManuscriptService;
  const work = { current: undefined } as IWorkService;
  const pane = new WelcomeEditorPane(commands, manuscript, work);
  const input = new WelcomeEditorInput();
  pane.create(parent);
  return { pane, input, section: parent.querySelector('section')! };
}

test('does not render a list response after the Welcome pane is disposed', async () => {
  let settle!: (works: ManuscriptWork[]) => void;
  const { pane, input, section } = welcome(() => new Promise(resolve => { settle = resolve; }), 'ready');
  await pane.setInput(input, undefined);
  expect(section.querySelector('[role="status"]')?.textContent).toBe('Loading Works...');
  pane.dispose();
  input.dispose();

  settle([{ id: '12345678-abcd-4000-8000-123456789abc', title: 'Late Work', updatedAt: 1, createdAt: 1 }]);
  await Promise.resolve();
  expect(section.textContent).not.toContain('Late Work');
});

test('shows the sign-in message when the Works request is unauthorized', async () => {
  const { pane, input, section } = welcome(
    () => Promise.reject(new ManuscriptStoreError('unauthorized')), 'signedOut',
  );
  try {
    await pane.setInput(input, undefined);
    await vi.waitFor(() => expect(section.querySelector('[role="status"]')?.textContent).toBe('Sign in to see your Works.'));
    expect(section.querySelector('.welcome-works-account')).not.toBeNull();
  } finally {
    pane.dispose();
    input.dispose();
  }
});
