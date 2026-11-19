import { afterEach, beforeEach, expect, test } from 'vitest';
import { MenuId, MenuRegistry, isIMenuItem } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import type { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import '../../../../browser/parts/views/defaultViews.contribution.js';
import { viewContainersRegistry, viewsRegistry } from '../../../../common/views.js';
import type { IViewDescriptorService } from '../../../../common/views.js';
import type { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IOutputService, OUTPUT_VIEW_ID } from '../../../../services/output/common/output.js';
import type { IViewsService } from '../../../../services/views/browser/viewsService.js';
import { OutputViewContribution } from '../../browser/output.contribution.js';
import { OutputService } from '../../browser/outputServices.js';
import { MAX_RENDERED_LINE_LENGTH, OutputView } from '../../browser/outputView.js';

let service: OutputService;
let container: HTMLElement;
let view: OutputView;

beforeEach(() => {
  service = new OutputService(
    {} as IViewsService, {} as IViewDescriptorService, {} as IContextKeyService, {} as IWorkbenchLayoutService,
  );
  container = document.createElement('div');
  document.body.append(container);
  view = new OutputView(container, service);
});

afterEach(() => {
  view.dispose();
  document.body.replaceChildren();
});

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const shownLines = () => [...view.log.children].map(line => line.textContent);
const options = () => [...view.channelList.querySelectorAll('[role=option]')].map(option => option.textContent);

test('the view has a channel list and a read-only log, and no placeholder', () => {
  expect(view.channelList.getAttribute('role')).toBe('listbox');
  expect(view.channelList.getAttribute('aria-label')).toBe('Output Channels');
  expect(view.element.querySelector('select, [role=combobox]')).toBeNull();
  expect(view.log.getAttribute('role')).toBe('log');
  expect(view.log.getAttribute('aria-label')).toBe('Output');
  expect(view.log.getAttribute('contenteditable')).toBeNull();
  expect(view.log.getAttribute('aria-readonly')).toBe('true');
  expect(document.body.textContent).not.toContain('No output yet');
});

test('nothing in the view changes while it is hidden, and all of it is there when it shows', async () => {
  container.hidden = true;
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver(records => changes.push(...records));
  observer.observe(view.element, { subtree: true, childList: true, attributes: true, characterData: true });
  const channel = service.registerChannel({ id: 'one', label: 'One' });
  channel.append('first\n');
  channel.append('second\npartial');
  service.registerChannel({ id: 'two', label: 'Two' });
  await tick();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(changes.concat(observer.takeRecords())).toEqual([]);
  expect(shownLines()).toEqual([]);

  container.hidden = false;
  view.layoutBody(200, 800);
  expect(options()).toEqual(['One', 'Two']);
  expect(shownLines()).toEqual(['first', 'second', 'partial']);
  observer.disconnect();
});

test('new output is added to what is drawn, and the oldest drawn lines go with the channel\'s', async () => {
  const channel = service.registerChannel({ id: 'one', label: 'One' });
  channel.append('a\nb');
  await tick();
  const first = view.log.children[0];
  channel.append('c\nd\n');
  await tick();
  expect(shownLines()).toEqual(['a', 'bc', 'd']);
  expect(view.log.children[0]).toBe(first);

  // Past the channel's limit: lines of 1 KiB each, 2 MiB in all.
  const filler = 'x'.repeat(1000);
  for (let index = 0; index < 2000; index++) {
    channel.append(`${filler} ${index}\n`);
    if (index % 500 === 0) {
      await tick();
    }
  }
  await tick();
  const model = channel.model;
  expect(model.firstLine).toBeGreaterThan(0);
  expect(view.log.children).toHaveLength(model.lineCount);
  expect(view.log.firstElementChild!.textContent).toBe(model.getLine(model.firstLine));
  expect(view.log.lastElementChild!.textContent).toBe(`${filler} 1999`);
});

test('a very long line is drawn only up to a length, with a note of the rest', async () => {
  const channel = service.registerChannel({ id: 'one', label: 'One' });
  channel.append('y'.repeat(1024 * 1024 - 1) + '\n');
  await tick();
  const line = view.log.firstElementChild!;
  expect(line.firstChild!.textContent).toHaveLength(MAX_RENDERED_LINE_LENGTH);
  expect(line.querySelector('.output-line-truncated')!.textContent)
    .toBe(` … ${(1024 * 1024 - 1 - MAX_RENDERED_LINE_LENGTH).toLocaleString('en-US')} more characters not shown`);
});

test('the list chooses the channel with a click or the arrow keys, and follows the active channel', async () => {
  service.registerChannel({ id: 'b', label: 'Beta' }).append('beta text');
  service.registerChannel({ id: 'a', label: 'Alpha' }).append('alpha text');
  await tick();
  expect(options()).toEqual(['Alpha', 'Beta']);
  const selected = () => view.channelList.querySelector('[aria-selected=true]')?.textContent;
  expect(selected()).toBe('Beta');
  expect(view.channelList.getAttribute('aria-activedescendant'))
    .toBe(view.channelList.querySelector('[aria-selected=true]')!.id);

  view.channelList.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  await tick();
  expect(selected()).toBe('Alpha');
  expect(shownLines()).toEqual(['alpha text']);
  (view.channelList.querySelectorAll('[role=option]')[1] as HTMLElement).click();
  await tick();
  expect(service.getActiveChannel()?.id).toBe('b');
  expect(shownLines()).toEqual(['beta text']);

  service.getChannel('b')!.dispose();
  await tick();
  expect(options()).toEqual(['Alpha']);
  expect(selected()).toBe('Alpha');
});

test('the text follows new output only while it is scrolled to the end', async () => {
  const metrics = { scrollHeight: 1000, clientHeight: 100 };
  Object.defineProperty(view.log, 'scrollHeight', { get: () => metrics.scrollHeight });
  Object.defineProperty(view.log, 'clientHeight', { get: () => metrics.clientHeight });
  const channel = service.registerChannel({ id: 'one', label: 'One' });
  channel.append('start\n');
  await tick();
  expect(view.log.scrollTop).toBe(1000);

  view.log.scrollTop = 200;
  view.log.dispatchEvent(new Event('scroll'));
  metrics.scrollHeight = 1200;
  channel.append('more\n');
  await tick();
  expect(view.log.scrollTop).toBe(200);

  view.log.scrollTop = 1100;
  view.log.dispatchEvent(new Event('scroll'));
  metrics.scrollHeight = 1400;
  channel.append('again\n');
  await tick();
  expect(view.log.scrollTop).toBe(1400);
});

test('Clear Output clears the active channel and has a button in the view title', () => {
  const channel = service.registerChannel({ id: 'one', label: 'One' });
  channel.append('text\n');
  const accessor = { get: (id: unknown) => id === IOutputService ? service : undefined } as unknown as ServicesAccessor;
  CommandsRegistry.getCommand('workbench.output.action.clearOutput')!.handler(accessor);
  expect(channel.model.getText()).toBe('');
  const item = MenuRegistry.getMenuItems(MenuId.ViewTitle).filter(isIMenuItem)
    .find(entry => entry.command.id === 'workbench.output.action.clearOutput');
  expect(item?.group).toBe('navigation');
  expect(item?.when?.keys()).toEqual(['view']);
  expect(item?.command.title).toBe('Clear Output');
});

test('the contribution puts the Output view in place of the placeholder, in the same container', () => {
  const outputContainer = viewContainersRegistry.get(OUTPUT_VIEW_ID)!;
  expect(viewsRegistry.getViews(outputContainer).map(view => view.id)).toEqual([OUTPUT_VIEW_ID]);
  const instantiation = {
    createInstance: (_ctor: unknown, parent: HTMLElement) => new OutputView(parent, service),
  } as unknown as IInstantiationService;
  new OutputViewContribution(instantiation);
  const views = viewsRegistry.getViews(outputContainer);
  expect(views.map(view => [view.id, view.name])).toEqual([[OUTPUT_VIEW_ID, 'Output']]);
  expect(viewsRegistry.getViewContainer(OUTPUT_VIEW_ID)).toBe(outputContainer);
  const parent = document.createElement('div');
  document.body.append(parent);
  const body = views[0].renderBody(parent);
  expect(parent.textContent).not.toContain('No output yet');
  expect(parent.querySelector('[role=listbox][aria-label="Output Channels"]')).not.toBeNull();
  body?.dispose?.();
});
