import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { IViewDescriptorService } from '../../../common/views.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { OutputService } from '../../../contrib/output/browser/outputServices.js';
import { OutputView } from '../../../contrib/output/browser/outputView.js';
import type { HostExtensionDescription } from '../../../services/extensions/common/extensionHostProtocol.js';
import { Parts } from '../../../services/layout/browser/layoutService.js';
import type { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { OUTPUT_VIEW_ID } from '../../../services/output/common/output.js';
import type { IViewsService } from '../../../services/views/browser/viewsService.js';
import { MainThreadOutputService } from '../../browser/mainThreadOutputService.js';
import { MainThreadOutputServiceProxy } from '../../common/extHost.protocol.windowUi.js';
import type { MainThreadOutputServiceShape } from '../../common/extHost.protocol.windowUi.js';
import { ExtHostOutputService, OUTPUT_FLUSH_DELAY, OUTPUT_FLUSH_SIZE } from '../../common/extHostOutput.js';
import { LogLevel } from '../../common/extHostTypes.js';
import { createDomRpcPair, settle } from './windowUiTestRpc.js';

function extension(key: string, id: string, displayName?: string): HostExtensionDescription {
  const [publisher, name] = id.split('.');
  return {
    key, id, location: `https://example.test/${key}/`, entry: `https://example.test/${key}/extension.js`, activationEvents: [],
    manifest: { name, publisher, version: '1.0.0', ...displayName ? { displayName } : {} },
  };
}

let pair: ReturnType<typeof createDomRpcPair>;
let extensions: Map<string, HostExtensionDescription>;
let opened: [string, boolean | undefined][];
let hidden: Parts[];
let context: Map<string, unknown>;
let service: OutputService;
let main: MainThreadOutputService;
let host: ExtHostOutputService;
let view: OutputView;

beforeEach(() => {
  extensions = new Map([['a', extension('a', 'test.alpha', 'Alpha')], ['b', extension('b', 'test.beta')]]);
  opened = [];
  hidden = [];
  context = new Map();
  const views = { openView: async (id: string, focus?: boolean) => { opened.push([id, focus]); return null; } } as IViewsService;
  const container = { id: OUTPUT_VIEW_ID, title: 'Output' };
  const viewDescriptors = {
    getViewContainerById: (id: string) => id === OUTPUT_VIEW_ID ? container : undefined,
    getViewContainerLocation: () => ViewContainerLocation.Panel,
  } as unknown as IViewDescriptorService;
  const contextKeys = { getContextKeyValue: (key: string) => context.get(key) } as unknown as IContextKeyService;
  const layout = { setPartHidden: (_hidden: boolean, part: Parts) => hidden.push(part) } as unknown as IWorkbenchLayoutService;
  service = new OutputService(views, viewDescriptors, contextKeys, layout);
  pair = createDomRpcPair();
  main = new MainThreadOutputService(service, key => extensions.get(key));
  pair.main.set(MainThreadOutputServiceProxy, main);
  host = new ExtHostOutputService(pair.worker.getProxy(MainThreadOutputServiceProxy));
  const parent = document.createElement('div');
  document.body.append(parent);
  view = new OutputView(parent, service);
});

afterEach(() => {
  vi.useRealTimers();
  view.dispose();
  host.dispose();
  main.dispose();
  pair.dispose();
  document.body.replaceChildren();
});

/** Lets the batching delay pass and the writes arrive. */
async function arrive(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, OUTPUT_FLUSH_DELAY + 10));
  await settle();
}

const channelNames = () => [...view.channelList.querySelectorAll('[role=option]')].map(option => option.textContent);
const selected = () => view.channelList.querySelector('[aria-selected=true]')?.textContent;
const shownLines = () => [...view.log.children].map(line => line.textContent);
const text = (id = service.getActiveChannel()?.id) => id ? service.getChannel(id)!.model.getText() : undefined;

/** A host whose calls to the workbench are recorded instead of sent. */
function recordingHost() {
  const calls: unknown[][] = [];
  const proxy = new Proxy({}, {
    get: (_target, name) => async (...args: unknown[]) => { calls.push([name, ...args.slice(2)]); },
  }) as MainThreadOutputServiceShape;
  return { calls, host: new ExtHostOutputService(proxy) };
}

test('10,000 appends and appendLines arrive in order, and the end of the text is shown', async () => {
  const channel = host.createOutputChannel('a', 'Builds') as vscode.OutputChannel;
  for (let index = 0; index < 10_000; index++) {
    channel.append(`a${index} `);
    channel.appendLine(`b${index}`);
  }
  await arrive();
  const lines = text()!.split('\n');
  expect(lines).toHaveLength(10_001);
  expect(lines.slice(-4)).toEqual(['a9997 b9997', 'a9998 b9998', 'a9999 b9999', '']);
  expect(lines.every((line, index) => index === 10_000 || line === `a${index} b${index}`)).toBe(true);
  expect(shownLines().slice(-2)).toEqual(['a9998 b9998', 'a9999 b9999']);
  expect(channelNames()).toEqual(['Builds']);
});

test('writes wait 50 ms or until 64 KiB, and go to the workbench in the order written', () => {
  vi.useFakeTimers();
  const { calls, host: recording } = recordingHost();
  const channel = recording.createOutputChannel('a', 'Builds') as vscode.OutputChannel;
  const other = recording.createOutputChannel('a', 'Tests') as vscode.OutputChannel;
  channel.appendLine('one');
  other.append('x');
  channel.appendLine('two');
  vi.advanceTimersByTime(OUTPUT_FLUSH_DELAY - 1);
  expect(calls.map(([name]) => name)).toEqual(['$register', '$register']);
  vi.advanceTimersByTime(1);
  expect(calls.slice(2)).toEqual([['$append', 'one\ntwo\n'], ['$append', 'x']]);

  calls.length = 0;
  channel.append('y'.repeat(OUTPUT_FLUSH_SIZE - 1));
  expect(calls).toEqual([]);
  channel.append('z');
  expect(calls).toEqual([['$append', 'y'.repeat(OUTPUT_FLUSH_SIZE - 1) + 'z']]);
  recording.dispose();
});

test('clear and replace drop the writes waiting before them; show and hide send them first', () => {
  vi.useFakeTimers();
  const { calls, host: recording } = recordingHost();
  const channel = recording.createOutputChannel('a', 'Builds') as vscode.OutputChannel;
  channel.append('old');
  channel.clear();
  channel.append('new');
  channel.replace('fresh');
  channel.append('later');
  channel.show(true);
  channel.append('hidden');
  channel.hide();
  expect(calls.slice(1)).toEqual([
    ['$clear'], ['$replace', 'fresh'], ['$append', 'later'], ['$reveal', true], ['$append', 'hidden'], ['$close'],
  ]);
  vi.advanceTimersByTime(OUTPUT_FLUSH_DELAY);
  expect(calls).toHaveLength(7);
  recording.dispose();
});

test('the text from before a clear never comes back, even writes that were waiting', async () => {
  const channel = host.createOutputChannel('a', 'Builds') as vscode.OutputChannel;
  channel.appendLine('sent');
  await arrive();
  channel.appendLine('waiting');
  channel.clear();
  channel.appendLine('after');
  await arrive();
  expect(text()).toBe('after\n');
  expect(shownLines()).toEqual(['after']);

  channel.appendLine('more');
  channel.replace('replaced\n');
  await arrive();
  expect(text()).toBe('replaced\n');
  expect(shownLines()).toEqual(['replaced']);
});

test('show reveals the Output view on the channel and keeps focus when asked', async () => {
  const first = host.createOutputChannel('a', 'First') as vscode.OutputChannel;
  const second = host.createOutputChannel('a', 'Second') as vscode.OutputChannel;
  second.appendLine('second text');
  await settle();
  expect(selected()).toBe('First');

  second.show(true);
  await settle();
  expect(opened).toEqual([[OUTPUT_VIEW_ID, false]]);
  expect(selected()).toBe('Second');
  // The writes before `show` are there when the view opens.
  expect(text()).toBe('second text\n');
  expect(shownLines()).toEqual(['second text']);

  first.show();
  await settle();
  expect(opened.at(-1)).toEqual([OUTPUT_VIEW_ID, true]);
  expect(selected()).toBe('First');
  second.show(2 as vscode.ViewColumn, true);
  await settle();
  expect(opened.at(-1)).toEqual([OUTPUT_VIEW_ID, false]);
  expect(selected()).toBe('Second');
});

test('hide closes the part only when the view shows that channel', async () => {
  const first = host.createOutputChannel('a', 'First') as vscode.OutputChannel;
  const second = host.createOutputChannel('a', 'Second') as vscode.OutputChannel;
  await settle();
  second.hide();
  first.hide();
  await settle();
  expect(hidden).toEqual([]);

  context.set('activePanel', OUTPUT_VIEW_ID);
  second.hide();
  await settle();
  expect(hidden).toEqual([]);
  first.hide();
  await settle();
  expect(hidden).toEqual([Parts.PANEL_PART]);
});

test('a disposed channel leaves the list and throws when used, as in VS Code', async () => {
  const kept = host.createOutputChannel('a', 'Kept') as vscode.OutputChannel;
  const gone = host.createOutputChannel('a', 'Gone') as vscode.OutputChannel;
  gone.appendLine('never shown');
  await settle();
  expect(channelNames()).toEqual(['Gone', 'Kept']);
  gone.dispose();
  await arrive();
  expect(channelNames()).toEqual(['Kept']);
  expect(service.getChannelDescriptors().map(channel => channel.label)).toEqual(['Kept']);
  expect(() => gone.appendLine('late')).toThrow('Channel has been closed');
  expect(() => gone.show()).toThrow('Channel has been closed');
  gone.dispose();
  kept.appendLine('still here');
  await arrive();
  expect(text()).toBe('still here\n');
});

test('removing an extension removes its channels, and its host side ignores later writes', async () => {
  const alpha = host.createOutputChannel('a', 'Alpha Log') as vscode.OutputChannel;
  host.createOutputChannel('b', 'Beta Log');
  await settle();
  expect(channelNames()).toEqual(['Alpha Log', 'Beta Log']);

  extensions.delete('a');
  main.remove('a');
  await settle();
  expect(channelNames()).toEqual(['Beta Log']);
  host.release('a');
  expect(() => alpha.appendLine('after removal')).not.toThrow();
  await arrive();
  expect(service.getChannelDescriptors().map(channel => channel.label)).toEqual(['Beta Log']);
});

test('releasing an extension drops its waiting writes and sends nothing for its channels after', () => {
  vi.useFakeTimers();
  const { calls, host: recording } = recordingHost();
  const alpha = recording.createOutputChannel('a', 'Alpha Log') as vscode.OutputChannel;
  const beta = recording.createOutputChannel('b', 'Beta Log') as vscode.OutputChannel;
  alpha.append('waiting');
  recording.release('a');
  alpha.appendLine('after release');
  alpha.show();
  beta.append('kept');
  vi.advanceTimersByTime(OUTPUT_FLUSH_DELAY);
  expect(calls.slice(2)).toEqual([['$dispose'], ['$append', 'kept']]);
  recording.dispose();
});

test('the workbench takes nothing it should not from the extension host', async () => {
  const proxy = pair.worker.getProxy(MainThreadOutputServiceProxy);
  await proxy.$register('z', 1, 'Unknown extension');
  await proxy.$register('a', 1, '   ');
  await proxy.$register('a', 1.5, 'Bad handle');
  await proxy.$register('a', 1, { label: 'Object' } as unknown as string);
  expect(service.getChannelDescriptors()).toEqual([]);

  await proxy.$register('a', 1, 'Alpha');
  await proxy.$append('a', 1, 'mine\n');
  // Another extension cannot reach the channel by its number, and only text is written.
  await proxy.$append('b', 1, 'theirs\n');
  await proxy.$clear('b', 1);
  await proxy.$dispose('b', 1);
  await proxy.$append('a', 1, { length: 3 } as unknown as string);
  await proxy.$append('a', 1, '<img src=x onerror=alert(1)>');
  await settle();
  expect(text()).toBe('mine\n<img src=x onerror=alert(1)>');
  expect(view.log.querySelector('img')).toBeNull();
  expect(shownLines()).toEqual(['mine', '<img src=x onerror=alert(1)>']);

  // The workbench keeps its own limit whatever the host sends.
  await proxy.$append('a', 1, 'x'.repeat(1024 * 1024) + '\nend\n');
  await settle();
  expect(service.getActiveChannel()!.model.size).toBeLessThanOrEqual(1024 * 1024);
  expect(text()).toBe('end\n');
});

test('two extensions with a channel of the same name keep two channels, told apart by extension name', async () => {
  const alpha = host.createOutputChannel('a', 'Language Server') as vscode.OutputChannel;
  const beta = host.createOutputChannel('b', 'Language Server') as vscode.OutputChannel;
  host.createOutputChannel('b', 'Other');
  alpha.appendLine('from alpha');
  beta.appendLine('from beta');
  await arrive();
  expect(channelNames()).toEqual(['Language Server (Alpha)', 'Language Server (test.beta)', 'Other']);
  expect(service.getChannelDescriptors().map(channel => text(channel.id))).toEqual(['from alpha\n', 'from beta\n', '']);
});

test('a log channel writes lines at or above its level with the time and level in front', async () => {
  const channel = host.createOutputChannel('a', 'Markdown', { log: true }) as vscode.LogOutputChannel;
  expect(channel.logLevel).toBe(LogLevel.Info);
  expect(typeof channel.onDidChangeLogLevel).toBe('function');
  channel.trace('hidden trace');
  channel.debug('hidden debug');
  channel.info('started', { port: 1 }, 2);
  channel.warn('slow');
  channel.appendLine('plain');
  const error = new Error('broken');
  error.stack = 'Error: broken\n    at test';
  channel.error(error);
  channel.error('failed', new Error('cause'));
  await arrive();
  const prefix = String.raw`\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}`;
  expect(text()).toMatch(new RegExp('^' + [
    `${prefix} \\[info\\] started \\{"port":1\\} 2`,
    `${prefix} \\[warning\\] slow`,
    `${prefix} \\[info\\] plain`,
    `${prefix} \\[error\\] Error: broken\\n    at test`,
    `${prefix} \\[error\\] failed cause`,
  ].join('\\n') + '\\n$'));
  expect(text()).not.toContain('hidden');
});

test('a channel needs a name, and its name is trimmed', () => {
  expect(() => host.createOutputChannel('a', '  ')).toThrow('illegal argument `name`. must not be falsy');
  expect(() => host.createOutputChannel('a', 'Name', ' ')).toThrow('illegal argument `languageId`. must not be empty');
  expect(host.createOutputChannel('a', ' Named ', 'json').name).toBe('Named');
});
