// @vitest-environment node
import { expect, test } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { MarkerService } from '../../common/markerService.js';
import { limitMarkers, MarkerSeverity } from '../../common/markers.js';
import type { IMarkerData } from '../../common/markers.js';

function marker(message: string, severity = MarkerSeverity.Error, line = 1): IMarkerData {
  return { message, severity, startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 2 };
}

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));

test('a change replaces what the owner had for the resource and leaves other owners alone', () => {
  const service = new MarkerService();
  const resource = URI.parse('untitled:Untitled-1');
  service.changeOne('a', resource, [marker('one'), marker('two')]);
  service.changeOne('b', resource, [marker('theirs')]);
  service.changeOne('a', resource, [marker('three')]);
  expect(service.read({ owner: 'a' }).map(item => item.message)).toEqual(['three']);
  expect(service.read({ resource }).map(item => item.owner + ':' + item.message)).toEqual(['a:three', 'b:theirs']);

  service.changeAll('a', []);
  expect(service.read({ resource }).map(item => item.message)).toEqual(['theirs']);
  expect(service.getStatistics()).toEqual({ errors: 1, warnings: 0, infos: 0, unknowns: 0 });
});

test('changes in one run fire one event that names each changed resource once', async () => {
  const service = new MarkerService();
  const first = URI.parse('vscode-vfs://writing-room/workspace/a.md');
  const second = URI.parse('vscode-vfs://writing-room/workspace/b.md');
  const events: string[][] = [];
  service.onMarkerChanged(resources => events.push(resources.map(String)));

  service.changeOne('a', first, [marker('x')]);
  service.changeOne('a', first, [marker('y')]);
  service.changeOne('b', second, [marker('z')]);
  // Removing what is not there changes nothing.
  service.remove('a', [URI.parse('untitled:Untitled-9')]);
  await tick();
  expect(events).toEqual([[first.toString(), second.toString()]]);

  service.changeAll('b', []);
  await tick();
  expect(events).toEqual([[first.toString(), second.toString()], [second.toString()]]);
  service.changeAll('b', []);
  await tick();
  expect(events).toHaveLength(2);
});

test('two spellings of one resource are one key', () => {
  const service = new MarkerService();
  service.changeOne('a', URI.parse('untitled:my%20notes'), [marker('one')]);
  service.changeOne('a', URI.parse('untitled:my notes'), [marker('two')]);
  expect(service.read().map(item => item.message)).toEqual(['two']);
});

test('broken positions become the first line and column instead of throwing', () => {
  const service = new MarkerService();
  const resource = URI.parse('untitled:Untitled-1');
  service.changeOne('a', resource, [
    { message: 'negative', severity: MarkerSeverity.Warning, startLineNumber: -4, startColumn: -1, endLineNumber: 0, endColumn: Number.NaN },
    { message: 'reversed', severity: MarkerSeverity.Info, startLineNumber: 5, startColumn: 3, endLineNumber: 2, endColumn: 9 },
    { message: '', severity: MarkerSeverity.Error, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  ]);
  expect(service.read().map(({ message, startLineNumber, startColumn, endLineNumber, endColumn }) =>
    [message, startLineNumber, startColumn, endLineNumber, endColumn])).toEqual([
    ['negative', 1, 1, 1, 1],
    ['reversed', 5, 3, 5, 3],
  ]);
  expect(service.read({ severities: MarkerSeverity.Warning | MarkerSeverity.Error }).map(item => item.message)).toEqual(['negative']);
  expect(service.read({ take: 1 })).toHaveLength(1);
});

test('the limit keeps the most severe markers in their order and says how many were left out', () => {
  const markers = [
    ...Array.from({ length: 700 }, (_, index) => marker('hint ' + index, MarkerSeverity.Hint, index + 1)),
    ...Array.from({ length: 500 }, (_, index) => marker('error ' + index, MarkerSeverity.Error, index + 1)),
    ...Array.from({ length: 300 }, (_, index) => marker('warning ' + index, MarkerSeverity.Warning, index + 1)),
  ];
  const limited = limitMarkers(markers);
  expect(limited).toHaveLength(1001);
  expect(limited.filter(item => item.severity === MarkerSeverity.Error)).toHaveLength(500);
  expect(limited.filter(item => item.severity === MarkerSeverity.Warning)).toHaveLength(300);
  expect(limited.filter(item => item.severity === MarkerSeverity.Hint)).toHaveLength(200);
  expect(limited.at(-1)).toEqual({ ...marker('Not showing 500 further errors and warnings.', MarkerSeverity.Info, 200) });
  expect(limitMarkers(markers.slice(0, 1000))).toHaveLength(1000);
});
