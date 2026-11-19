// @vitest-environment node
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { TestModelService } from '../../../../../editor/test/common/testTextModel.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import type { IMarker } from '../../../../../platform/markers/common/markers.js';
import { MarkersModelBridge } from '../../browser/markersModelBridge.js';

const marker = (message: string) => ({ message, severity: MarkerSeverity.Error, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 });
const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
let disposables: DisposableStore;

beforeEach(() => { disposables = new DisposableStore(); });
afterEach(() => disposables.dispose());

function setup() {
  const markers = disposables.add(new MarkerService());
  const models = new TestModelService();
  const calls: string[] = [];
  /** What Monaco would show, by model and owner. */
  const shown = new Map<string, string[]>();
  const sink = {
    setModelMarkers(model: ITextModel, owner: string, list: readonly IMarker[]) {
      calls.push(model.uri + ' ' + owner + ' ' + list.map(item => item.message).join());
      shown.set(model.uri + ' ' + owner, list.map(item => item.message));
    },
  };
  return { markers, models, calls, shown, start: () => disposables.add(new MarkersModelBridge(sink, markers, models)) };
}

test('markers given before the document opens are drawn when its model is made', async () => {
  const { markers, models, calls, start } = setup();
  const resource = URI.parse('untitled:Untitled-1');
  const before = await models.createModel('text', undefined, URI.parse('untitled:Untitled-2'));
  markers.changeOne('test.lint:lint', resource, [marker('early')]);
  start();
  expect(calls).toEqual([]);
  await models.createModel('text', undefined, resource);
  expect(calls).toEqual(['untitled:Untitled-1 test.lint:lint early']);
  expect(before.isDisposed()).toBe(false);
});

test('each owner is drawn on its own, so clearing one leaves the other on the model', async () => {
  const { markers, models, calls, shown, start } = setup();
  const resource = URI.parse('untitled:Untitled-1');
  await models.createModel('text', undefined, resource);
  start();
  markers.changeOne('a', resource, [marker('mine')]);
  markers.changeOne('b', resource, [marker('theirs')]);
  await tick();
  expect(shown.get('untitled:Untitled-1 a')).toEqual(['mine']);
  expect(shown.get('untitled:Untitled-1 b')).toEqual(['theirs']);

  calls.length = 0;
  markers.changeAll('a', []);
  await tick();
  expect(calls).toEqual(['untitled:Untitled-1 a ', 'untitled:Untitled-1 b theirs']);
  expect(calls.some(call => call === 'untitled:Untitled-1 b ')).toBe(false);
});

test('a resource without a model keeps its markers in the service and draws nothing', async () => {
  const { markers, calls, start } = setup();
  start();
  markers.changeOne('a', URI.parse('untitled:Untitled-7'), [marker('waiting')]);
  await tick();
  expect(calls).toEqual([]);
  expect(markers.read().map(item => item.message)).toEqual(['waiting']);
});
