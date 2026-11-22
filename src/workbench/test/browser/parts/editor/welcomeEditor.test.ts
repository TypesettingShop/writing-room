import { expect, test, vi } from 'vitest';
import { Event as WorkbenchEvent } from '../../../../../base/common/event.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ManuscriptStoreError, type ManuscriptWork } from '../../../../../platform/manuscript/common/manuscript.js';
import { WelcomeEditorInput, WelcomeEditorPane } from '../../../../browser/parts/editor/welcomeEditor.js';
import type { IManuscriptService, ManuscriptAvailability } from '../../../../services/manuscript/common/manuscriptService.js';
import type { IWorkService } from '../../../../services/work/common/work.js';

function welcome(listWorks: () => Promise<ManuscriptWork[]>, availability: ManuscriptAvailability) {
  const parent = document.createElement('div');
  const commands = { executeCommand: vi.fn() } as unknown as ICommandService;
  const manuscript = {
    store: { listWorks }, signedIn: availability === 'unavailable' ? undefined : availability === 'ready',
    onDidChangeAuth: WorkbenchEvent.None,
    auth: { hasGoogle: async () => false, signIn: vi.fn(), signOut: vi.fn() },
  };
  const work = { current: undefined } as IWorkService;
  const pane = new WelcomeEditorPane(commands, manuscript as unknown as IManuscriptService, work);
  const input = new WelcomeEditorInput();
  pane.create(parent);
  return { pane, input, section: parent.querySelector('section')!, manuscript };
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

test('keeps the same Work buttons while a refocus reads the list again', async () => {
  const entry = { id: '12345678-abcd-4000-8000-123456789abc', title: 'Kept Work', updatedAt: 1, createdAt: 1 };
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  let reads = 0;
  let settle!: (works: ManuscriptWork[]) => void;
  const { pane, input, section } = welcome(
    () => ++reads === 1 ? Promise.resolve([entry]) : new Promise(resolve => { settle = resolve; }), 'ready',
  );
  try {
    await pane.setInput(input, undefined);
    await vi.waitFor(() => expect(section.querySelector('li button')?.textContent).toBe('Kept Work'));
    const button = section.querySelector('li button');

    // The click that brings the window back fires `focus` first: the button must survive it.
    now.mockReturnValue(1_030_000);
    window.dispatchEvent(new Event('focus'));
    expect(reads).toBe(2);
    expect(section.querySelector('li button')).toBe(button);
    settle([entry]);
    await vi.waitFor(() => expect(section.querySelector('[role="status"]')?.textContent).toBe(''));
    expect(section.querySelector('li button')).toBe(button);
  } finally {
    now.mockRestore();
    pane.dispose();
    input.dispose();
  }
});

test('shows the sign-in message when the Works request is unauthorized', async () => {
  const { pane, input, section } = welcome(
    () => Promise.reject(new ManuscriptStoreError('unauthorized')), 'signedOut',
  );
  try {
    await pane.setInput(input, undefined);
    await vi.waitFor(() => expect(section.querySelector('[role="status"]')?.textContent).toBe('Sign in to see your Works.'));
    expect(section.querySelector<HTMLFormElement>('.welcome-works-account form')?.hidden).toBe(false);
  } finally {
    pane.dispose();
    input.dispose();
  }
});


test('clears the Google cancellation when a signed-in Works list arrives', async () => {
  let settle!: (works: ManuscriptWork[]) => void;
  const { pane, input, section } = welcome(() => new Promise(resolve => { settle = resolve; }), 'ready');
  try {
    await pane.setInput(input, undefined);
    pane.focusWorks(true);
    const alert = section.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Google sign-in was canceled.');
    expect(section.querySelector('form')?.hidden).toBe(true);
    settle([]);
    await vi.waitFor(() => {
      expect(section.querySelector('[role="status"]')?.textContent).toBe('No Works yet.');
      expect(alert?.textContent).toBe('');
    });
  } finally {
    pane.dispose();
    input.dispose();
  }
});

test('restores the New Work button after leaving the form and reopening during an outage', async () => {
  const { pane, input, section, manuscript } = welcome(
    () => Promise.reject(new Error('The network is unavailable.')), 'signedOut',
  );
  try {
    await pane.setInput(input, undefined);
    const newWork = Array.from(section.querySelectorAll('button')).find(button => button.textContent === 'New Work...')!;
    expect(newWork.hidden).toBe(true);
    pane.clearInput();
    manuscript.signedIn = true;
    await pane.setInput(input, undefined);
    await vi.waitFor(() => expect(section.querySelector('[role="status"]')?.textContent).toBe('The Works server is not available.'));
    expect(newWork.hidden).toBe(false);
  } finally {
    pane.dispose();
    input.dispose();
  }
});
