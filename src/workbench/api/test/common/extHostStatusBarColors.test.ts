import { expect, test, vi } from 'vitest';
import { ExtHostStatusBar } from '../../common/extHostStatusBar.js';
import { MarkdownString, StatusBarAlignment, ThemeColor } from '../../common/extHostTypes.js';
import type { StatusBarEntryDto } from '../../common/extHost.protocol.js';

function host() {
  const set = vi.fn(async (_extension: string, _key: string, _entry: StatusBarEntryDto) => {});
  const dispose = vi.fn(async () => {});
  return { set, dispose, service: new ExtHostStatusBar({ $setEntry: set, $disposeEntry: dispose }) };
}

const lastEntry = (set: ReturnType<typeof host>['set']) => set.mock.lastCall![2];

test('createStatusBarItem takes an id first, and without one the alignment first', async () => {
  const { set, service } = host();
  const named = service.createStatusBarItem('ext', 'build', StatusBarAlignment.Right, 7);
  expect(named.id).toBe('build');
  expect(named.alignment).toBe(StatusBarAlignment.Right);
  expect(named.priority).toBe(7);
  named.show();
  await Promise.resolve();
  expect(lastEntry(set)).toMatchObject({ id: 'build', alignment: 2, priority: 7 });

  const plain = service.createStatusBarItem('ext', StatusBarAlignment.Right, 3);
  expect(plain.alignment).toBe(StatusBarAlignment.Right);
  expect(plain.priority).toBe(3);
  plain.show();
  await Promise.resolve();
  expect(lastEntry(set).id).toBeUndefined();
  // Two items with the same id stay two items to the workbench.
  const again = service.createStatusBarItem('ext', 'build');
  again.show();
  await Promise.resolve();
  const keys = set.mock.calls.map(call => call[1]);
  expect(new Set(keys).size).toBe(3);
  expect(service.createStatusBarItem('ext', 'x').alignment).toBe(StatusBarAlignment.Left);
});

test('colors, background and accessibility go out with one update; the background brings its foreground', async () => {
  const { set, service } = host();
  const item = service.createStatusBarItem('ext');
  item.show();
  item.text = 'Build';
  item.color = '#ff8800';
  item.accessibilityInformation = { label: 'Build status: failing', role: 'link' };
  item.tooltip = new MarkdownString('**failing** <b>now</b>');
  await Promise.resolve();
  expect(set).toHaveBeenCalledOnce();
  expect(lastEntry(set)).toMatchObject({
    color: '#ff8800', tooltip: '**failing** <b>now</b>',
    accessibilityInformation: { label: 'Build status: failing', role: 'link' },
  });
  expect(lastEntry(set).backgroundColor).toBeUndefined();

  item.color = new ThemeColor('charts.green');
  await Promise.resolve();
  expect(lastEntry(set).color).toEqual({ id: 'charts.green' });

  item.backgroundColor = new ThemeColor('statusBarItem.errorBackground');
  expect(item.backgroundColor).toBeInstanceOf(ThemeColor);
  await Promise.resolve();
  expect(lastEntry(set)).toMatchObject({
    color: { id: 'statusBarItem.errorForeground' }, backgroundColor: { id: 'statusBarItem.errorBackground' },
  });
  // A plain object with an id crosses the wire as the id alone.
  expect(Object.keys(lastEntry(set).backgroundColor!)).toEqual(['id']);
});

test('a background other than error or warning is dropped when it is set', async () => {
  const { set, service } = host();
  const item = service.createStatusBarItem('ext');
  item.show();
  item.backgroundColor = new ThemeColor('statusBarItem.warningBackground');
  await Promise.resolve();
  expect(lastEntry(set).backgroundColor).toEqual({ id: 'statusBarItem.warningBackground' });
  item.backgroundColor = new ThemeColor('editor.background');
  expect(item.backgroundColor).toBeUndefined();
  await Promise.resolve();
  expect(lastEntry(set).backgroundColor).toBeUndefined();
  expect(lastEntry(set).color).toBeUndefined();
});
