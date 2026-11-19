import { afterEach, beforeEach, expect, test } from 'vitest';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import type { IMarkerData } from '../../../../../platform/markers/common/markers.js';
import type { IEditorService } from '../../../../services/editor/common/editorService.js';
import { buildMarkersModel } from '../../browser/markersModel.js';
import { MarkersView, markersViewDescriptor, provideMarkersViewServices } from '../../browser/markersView.js';

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const data = (message: string, severity: MarkerSeverity, line = 1, column = 1, extra: Partial<IMarkerData> = {}): IMarkerData =>
  ({ message, severity, startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column + 3, ...extra });
const settings = URI.parse('vscode-userdata:/User/settings.json');
const untitled = URI.parse('untitled:Untitled-1');
let disposables: DisposableStore;

beforeEach(() => { disposables = new DisposableStore(); });
afterEach(() => { disposables.dispose(); document.body.replaceChildren(); });

function setup() {
  const markers = disposables.add(new MarkerService());
  const opened: unknown[] = [];
  const editors = { openEditor: async (input: unknown) => { opened.push(input); return undefined; } } as unknown as IEditorService;
  const frames: (() => void)[] = [];
  const schedule = (callback: () => void) => {
    frames.push(callback);
    return toDisposable(() => { frames.splice(frames.indexOf(callback), 1); });
  };
  const parent = document.body.appendChild(document.createElement('div'));
  const view = disposables.add(new MarkersView(parent, markers, editors, schedule));
  const items = () => [...parent.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const texts = () => items().map(item => item.textContent);
  const frame = () => frames.splice(0).forEach(callback => callback());
  return { markers, opened, frames, parent, view, items, texts, frame };
}

test('says so when there are no problems', () => {
  const { parent } = setup();
  expect(parent.textContent).toBe('No problems have been detected in the workspace.');
  expect(parent.querySelector('[role="tree"]')).toBeNull();
});

test('groups by resource in URI order, with errors before warnings before infos before hints, then by position', async () => {
  const { markers, items, texts, frame } = setup();
  markers.changeOne('o', settings, [
    data('hint', MarkerSeverity.Hint, 1, 1),
    data('late error', MarkerSeverity.Error, 9, 2),
    data('info', MarkerSeverity.Info, 1, 1),
    data('warning', MarkerSeverity.Warning, 2, 1, { source: 'lint' }),
    data('early error', MarkerSeverity.Error, 3, 5, { source: 'lint', code: { value: 'E1', target: URI.parse('https://example.test') } }),
    data('same line error', MarkerSeverity.Error, 3, 1, { code: 'E2' }),
  ]);
  markers.changeOne('o', untitled, [data('untitled error', MarkerSeverity.Error)]);
  await tick();
  frame();
  expect(texts()).toEqual([
    // 'untitled:' sorts before 'vscode-userdata:'.
    'Untitled-11',
    'untitled error[Ln 1, Col 1]',
    'settings.json/User6',
    'same line errorE2[Ln 3, Col 1]',
    'early errorlint(E1)[Ln 3, Col 5]',
    'late error[Ln 9, Col 2]',
    'warninglint[Ln 2, Col 1]',
    'info[Ln 1, Col 1]',
    'hint[Ln 1, Col 1]',
  ]);
  expect(items().map(item => item.getAttribute('aria-level'))).toEqual(['1', '2', '1', '2', '2', '2', '2', '2', '2']);
});

test('builds at most the limit of rows, and counts what was left out', () => {
  const resources = [0, 1, 2].map(index => URI.parse('untitled:R-' + index));
  const all = resources.flatMap(resource => Array.from({ length: 4 }, (_, line) => ({
    ...data('m' + line, MarkerSeverity.Warning, line + 1), owner: 'o', resource,
  })));
  const model = buildMarkersModel(all, 6);
  expect(model.groups.map(group => [group.label, group.total, group.markers.length])).toEqual([['R-0', 4, 4], ['R-1', 4, 2]]);
  expect(model.hidden).toBe(6);
  expect(model.total).toBe(12);
});

test('shows one more row when markers are over the limit', async () => {
  const { markers, items, frame } = setup();
  markers.changeOne('o', untitled, Array.from({ length: 1000 }, (_, line) => data('m' + line, MarkerSeverity.Error, line + 1)));
  markers.changeOne('o', settings, Array.from({ length: 1000 }, (_, line) => data('m' + line, MarkerSeverity.Error, line + 1)));
  markers.changeOne('o', URI.parse('untitled:Z'), Array.from({ length: 5 }, (_, line) => data('z' + line, MarkerSeverity.Error, line + 1)));
  await tick();
  frame();
  expect(items()).toHaveLength(2000 + 3 + 1);
  expect(items().at(-1)!.textContent).toBe('5 more problems not shown');
});

test('gathers changes and draws once per frame', async () => {
  const { markers, frames, frame, texts } = setup();
  markers.changeOne('o', untitled, [data('one', MarkerSeverity.Error)]);
  await tick();
  markers.changeOne('o', untitled, [data('two', MarkerSeverity.Error)]);
  await tick();
  markers.changeOne('o', settings, [data('three', MarkerSeverity.Error)]);
  await tick();
  // Nothing is drawn before the frame, and the three changes ask for one frame.
  expect(texts()).toEqual([]);
  expect(frames).toHaveLength(1);
  frame();
  expect(texts()).toEqual(['Untitled-11', 'two[Ln 1, Col 1]', 'settings.json/User1', 'three[Ln 1, Col 1]']);
  markers.changeOne('o', untitled, []);
  await tick();
  expect(frames).toHaveLength(1);
});

test('keeps focus on the same row when the list is drawn again', async () => {
  const { markers, items, frame, parent } = setup();
  markers.changeOne('o', untitled, [data('a', MarkerSeverity.Error, 1), data('b', MarkerSeverity.Error, 2), data('c', MarkerSeverity.Error, 3)]);
  await tick();
  frame();
  const rows = () => items().filter(item => item.getAttribute('aria-level') === '2');
  rows()[1].focus();
  expect(rows()[1].tabIndex).toBe(0);
  markers.changeOne('o', untitled, [data('a', MarkerSeverity.Error, 1), data('b', MarkerSeverity.Error, 2), data('d', MarkerSeverity.Error, 4)]);
  await tick();
  frame();
  expect(document.activeElement).toBe(rows()[1]);
  expect(document.activeElement?.textContent).toContain('b');
  expect(parent.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  // The focused row went: focus falls back to its group.
  markers.changeOne('o', untitled, [data('a', MarkerSeverity.Error, 1), data('d', MarkerSeverity.Error, 4)]);
  await tick();
  frame();
  expect(document.activeElement).toBe(items()[0]);
});

test('opens a row on click and on Enter, with its range selected', async () => {
  const { markers, items, frame, opened } = setup();
  markers.changeOne('o', settings, [data('first', MarkerSeverity.Error, 2, 3), data('second', MarkerSeverity.Warning, 4, 1)]);
  await tick();
  frame();
  items()[1].click();
  const range = (startLineNumber: number, startColumn: number) =>
    ({ resource: settings, options: { selection: { startLineNumber, startColumn, endLineNumber: startLineNumber, endColumn: startColumn + 3 } } });
  expect(opened).toEqual([range(2, 3)]);
  items()[2].focus();
  items()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(opened).toEqual([range(2, 3), range(4, 1)]);
});

test('moves with the arrow keys and collapses and expands a group', async () => {
  const { markers, items, frame, texts } = setup();
  markers.changeOne('o', untitled, [data('a', MarkerSeverity.Error, 1), data('b', MarkerSeverity.Error, 2)]);
  markers.changeOne('o', settings, [data('c', MarkerSeverity.Error, 1)]);
  await tick();
  frame();
  const press = (key: string) => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  items()[0].focus();
  press('ArrowDown');
  expect(document.activeElement).toBe(items()[1]);
  press('ArrowUp');
  expect(document.activeElement).toBe(items()[0]);
  press('End');
  expect(document.activeElement).toBe(items().at(-1));
  press('ArrowLeft');
  expect(document.activeElement).toBe(items()[3]);
  press('ArrowLeft');
  expect(items()[3].getAttribute('aria-expanded')).toBe('false');
  expect(texts()).toHaveLength(4);
  expect(document.activeElement).toBe(items()[3]);
  press('ArrowRight');
  expect(items()[3].getAttribute('aria-expanded')).toBe('true');
  press('ArrowRight');
  expect(document.activeElement).toBe(items()[4]);
  press('Home');
  press('Enter');
  expect(items()[0].getAttribute('aria-expanded')).toBe('false');
  expect(items()).toHaveLength(3);
});

test('a view rendered before the services are there finishes when they arrive, and disposes in both states', async () => {
  const markers = disposables.add(new MarkerService());
  markers.changeOne('o', untitled, [data('early', MarkerSeverity.Error)]);
  const parent = document.body.appendChild(document.createElement('div'));
  const body = markersViewDescriptor.renderBody(parent)!;
  expect(parent.textContent).toBe('');
  disposables.add(provideMarkersViewServices({ markers, editors: {} as IEditorService }));
  expect(parent.textContent).toContain('early');
  body.dispose!();
  expect(parent.childElementCount).toBe(0);

  const later = document.body.appendChild(document.createElement('div'));
  // Services of the first provider are still held: dispose them to be 'not there yet'.
  disposables.clear();
  const waiting = markersViewDescriptor.renderBody(later)!;
  waiting.dispose!();
  const second = disposables.add(new MarkerService());
  second.changeOne('o', untitled, [data('late', MarkerSeverity.Error)]);
  disposables.add(provideMarkersViewServices({ markers: second, editors: {} as IEditorService }));
  expect(later.childElementCount).toBe(0);
});
