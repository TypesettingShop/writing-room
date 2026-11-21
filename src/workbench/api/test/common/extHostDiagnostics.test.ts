// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { URI } from '../../../../base/common/uri.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { MainThreadDiagnosticsProxy } from '../../common/extHost.protocol.diagnostics.js';
import type { MainThreadDiagnosticsShape, MarkerChangeDto } from '../../common/extHost.protocol.diagnostics.js';
import { Diagnostic, DiagnosticSeverity, DIAGNOSTICS_EVENT_DELAY, ExtHostDiagnostics } from '../../common/extHostDiagnostics.js';
import { Range } from '../../common/extHostEditorTypes.js';
import { createTestExtensionApi } from './testExtensionHost.js';

const uri = (value: string) => URI.parse(value) as unknown as vscode.Uri;
const diagnostic = (message: string, severity = DiagnosticSeverity.Error, line = 0) =>
  new Diagnostic(new Range(line, 0, line, 1), message, severity);

function setup() {
  const calls: { method: string; extension: string; collection: string; entries?: readonly MarkerChangeDto[] }[] = [];
  const proxy: MainThreadDiagnosticsShape = {
    $changeMany: async (extension, collection, entries) => { calls.push({ method: 'change', extension, collection, entries }); },
    $clear: async (extension, collection) => { calls.push({ method: 'clear', extension, collection }); },
    $requestMarkers: async () => {},
  };
  const diagnostics = new ExtHostDiagnostics(proxy);
  const events: string[][] = [];
  diagnostics.onDidChangeDiagnostics('listener')(event => events.push(event.uris.map(String)));
  return { diagnostics, calls, events };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('set replaces, and set with undefined, delete, clear and dispose empty the resource', () => {
  const { diagnostics, calls } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  const resource = uri('untitled:Untitled-1');
  collection.set(resource, [diagnostic('one'), diagnostic('two')]);
  collection.set(resource, [diagnostic('three')]);
  expect(collection.get(resource)!.map(item => item.message)).toEqual(['three']);
  expect(calls.at(-1)?.entries?.[0][1]?.map(item => item.message)).toEqual(['three']);

  collection.set(resource, undefined);
  expect(collection.has(resource)).toBe(false);
  expect(calls.at(-1)).toMatchObject({ method: 'change', entries: [[resource, undefined]] });

  collection.set(resource, [diagnostic('again')]);
  collection.delete(resource);
  expect(collection.has(resource)).toBe(false);
  collection.set(resource, [diagnostic('again')]);
  collection.clear();
  expect([...collection]).toEqual([]);
  expect(calls.at(-1)).toEqual({ method: 'clear', extension: '1', collection: 'lint' });

  collection.set(resource, [diagnostic('last')]);
  collection.dispose();
  expect(calls.at(-1)).toEqual({ method: 'clear', extension: '1', collection: 'lint' });
  expect(() => collection.set(resource, [])).toThrow('illegal state - object is disposed');
  expect(() => collection.name).toThrow('illegal state - object is disposed');
});

test('one set of many entries is one change and one event, naming only the resources it touched', async () => {
  const { diagnostics, calls, events } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  const untouched = uri('untitled:Untitled-3');
  collection.set(untouched, [diagnostic('stays')]);
  await vi.advanceTimersByTimeAsync(DIAGNOSTICS_EVENT_DELAY);
  events.length = 0;
  calls.length = 0;

  const first = uri('untitled:Untitled-1');
  const second = uri('untitled:Untitled-2');
  collection.set([
    [first, [diagnostic('a')]],
    [second, [diagnostic('b')]],
    [first, [diagnostic('c')]],
    [second, undefined],
    [second, [diagnostic('d')]],
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0].entries?.map(([resource, markers]) => [String(resource), markers?.map(item => item.message)])).toEqual([
    ['untitled:Untitled-1', ['a', 'c']],
    ['untitled:Untitled-2', ['d']],
  ]);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(DIAGNOSTICS_EVENT_DELAY);
  expect(events).toEqual([['untitled:Untitled-1', 'untitled:Untitled-2']]);

  // Deleting what is not there is no change.
  collection.delete(uri('untitled:Untitled-9'));
  await vi.advanceTimersByTimeAsync(DIAGNOSTICS_EVENT_DELAY);
  expect(events).toHaveLength(1);
});

test('a diagnostic that cannot be converted leaves the collection and the workbench as they were', () => {
  const { diagnostics, calls } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  const first = uri('untitled:Untitled-1');
  const second = uri('untitled:Untitled-2');
  collection.set(first, [diagnostic('kept')]);
  calls.length = 0;
  const broken = diagnostic('broken');
  (broken as { range: unknown }).range = undefined;
  expect(() => collection.set([[first, [diagnostic('lost')]], [second, [broken]]])).toThrow();
  expect(() => collection.set(first, [broken])).toThrow();
  expect(collection.get(first)!.map(item => item.message)).toEqual(['kept']);
  expect(collection.has(second)).toBe(false);
  expect(calls).toEqual([]);
});

test('two spellings of one resource are one entry', () => {
  const { diagnostics } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  collection.set(uri('untitled:my%20notes'), [diagnostic('one')]);
  collection.set(uri('untitled:my notes'), [diagnostic('two')]);
  expect([...collection].map(([resource, items]) => [String(resource), items.map(item => item.message)]))
    .toEqual([['untitled:my%20notes', ['two']]]);
});

test('more than 1,000 diagnostics send the most severe and a note on the rest', () => {
  const { diagnostics, calls } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  const resource = uri('untitled:Untitled-1');
  collection.set(resource, [
    ...Array.from({ length: 600 }, (_, index) => diagnostic('hint', DiagnosticSeverity.Hint, index)),
    ...Array.from({ length: 900 }, (_, index) => diagnostic('error', DiagnosticSeverity.Error, index)),
  ]);
  const sent = calls.at(-1)!.entries![0][1]!;
  expect(sent).toHaveLength(1001);
  expect(sent.filter(item => item.severity === MarkerSeverity.Error)).toHaveLength(900);
  expect(sent.filter(item => item.severity === MarkerSeverity.Hint)).toHaveLength(100);
  expect(sent.at(-1)).toMatchObject({ severity: MarkerSeverity.Info, message: 'Not showing 500 further errors and warnings.' });
  // The extension still reads back what it set.
  expect(collection.get(resource)!).toHaveLength(1500);
});

test('severities, ranges, codes and tags convert to markers as VS Code converts them', () => {
  const { diagnostics, calls } = setup();
  const collection = diagnostics.createDiagnosticCollection('1', 'lint');
  const resource = uri('untitled:Untitled-1');
  const items = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Information, DiagnosticSeverity.Hint]
    .map(severity => diagnostic('s', severity, 2));
  items[0].code = { value: 'MD001', target: uri('https://example.test/md001') };
  items[1].code = 42;
  items[2].code = 0;
  items[3].tags = [1, 2, 7 as never];
  collection.set(resource, items);
  const sent = calls.at(-1)!.entries![0][1]!;
  expect(sent.map(item => item.severity)).toEqual([8, 4, 2, 1]);
  expect(sent[0]).toMatchObject({ startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 2 });
  expect(sent[0].code).toEqual({ value: 'MD001', target: URI.parse('https://example.test/md001') });
  expect(sent[1].code).toBe('42');
  expect(sent[2].code).toBeUndefined();
  expect(sent[3].tags).toEqual([1, 2]);
});

test('names a diagnostics delivery failure by public id and sends the generation key', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failure = 'fixture delivery failure';
  const $changeMany = vi.fn(async () => { throw new Error(failure); });
  const $clear = vi.fn(async () => {});
  let host: Awaited<ReturnType<typeof createTestExtensionApi>> | undefined;
  try {
    host = await createTestExtensionApi();
    host.main.set(MainThreadDiagnosticsProxy, { $changeMany, $clear, async $requestMarkers() {} });
    const collection = host.api.languages.createDiagnosticCollection('lint');
    const resource = uri('untitled:Untitled-1');
    collection.set(resource, [diagnostic('fixture')]);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    collection.dispose();
    await vi.waitFor(() => expect($clear).toHaveBeenCalledExactlyOnceWith('1', 'lint'));
    expect($changeMany).toHaveBeenCalledExactlyOnceWith('1', 'lint', [[resource, expect.any(Array)]]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[test.api] Diagnostics of 'lint' did not reach the workbench:", expect.objectContaining({ message: failure }),
    );
    expect(warn.mock.calls[0][0]).not.toContain('[1]');
  } finally {
    host?.dispose();
    warn.mockRestore();
    errorLog.mockRestore();
  }
});

test('collections of the same name in two extensions, and in one, have their own owners', () => {
  const { diagnostics, calls } = setup();
  const mine = diagnostics.createDiagnosticCollection('1', 'lint');
  const theirs = diagnostics.createDiagnosticCollection('2', 'lint');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const second = diagnostics.createDiagnosticCollection('1', 'lint');
  warn.mockRestore();
  const resource = uri('untitled:Untitled-1');
  mine.set(resource, [diagnostic('mine')]);
  theirs.set(resource, [diagnostic('theirs')]);
  second.set(resource, [diagnostic('second')]);
  mine.clear();
  expect(calls.map(({ method, extension, collection }) => method + ' ' + extension + '/' + collection)).toEqual([
    'change 1/lint', 'change 2/lint', 'change 1/lint0', 'clear 1/lint',
  ]);
  expect(second.name).toBe('lint');
  expect(diagnostics.getDiagnostics(resource).map(item => item.message)).toEqual(['second', 'theirs']);
});

test('releasing an extension disposes its collections; getDiagnostics sees every owner and the workbench mirror', async () => {
  const { diagnostics, calls, events } = setup();
  const resource = uri('untitled:Untitled-1');
  const removed = diagnostics.createDiagnosticCollection('1', 'lint');
  removed.set(resource, [diagnostic('removed')]);
  diagnostics.createDiagnosticCollection('2', 'other').set(resource, [diagnostic('kept', DiagnosticSeverity.Warning)]);
  await diagnostics.$acceptMarkersChange([[URI.parse('untitled:Untitled-1'), [{
    severity: MarkerSeverity.Hint, message: 'from the workbench', source: 'json', code: 'x',
    startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 5,
  }]]]);
  const mirrored = diagnostics.getDiagnostics(resource).at(-1)!;
  expect(mirrored).toMatchObject({ message: 'from the workbench', severity: DiagnosticSeverity.Hint, source: 'json', code: 'x' });
  expect([mirrored.range.start.line, mirrored.range.start.character, mirrored.range.end.character]).toEqual([1, 2, 4]);

  calls.length = 0;
  diagnostics.release('1');
  expect(calls).toEqual([{ method: 'clear', extension: '1', collection: 'lint' }]);
  expect(() => removed.get(resource)).toThrow('illegal state');
  expect(diagnostics.getDiagnostics(resource).map(item => item.message)).toEqual(['kept', 'from the workbench']);
  expect((diagnostics.getDiagnostics() as [vscode.Uri, vscode.Diagnostic[]][]).map(([key, items]) => [String(key), items.length]))
    .toEqual([['untitled:Untitled-1', 2]]);

  await vi.advanceTimersByTimeAsync(DIAGNOSTICS_EVENT_DELAY);
  expect(events).toEqual([['untitled:Untitled-1']]);
  // An empty mirror entry for a resource the mirror does not have is no change.
  await diagnostics.$acceptMarkersChange([[URI.parse('untitled:Untitled-5'), []]]);
  await vi.advanceTimersByTimeAsync(DIAGNOSTICS_EVENT_DELAY);
  expect(events).toHaveLength(1);
});

test('a diagnostic needs a range and a message', () => {
  expect(() => new Diagnostic(undefined as never, 'message')).toThrow('range must be set');
  expect(() => new Diagnostic(new Range(0, 0, 0, 0), '')).toThrow('message must be set');
  const item = new Diagnostic({ start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } as never, 'm');
  expect(item.severity).toBe(DiagnosticSeverity.Error);
  expect(JSON.parse(JSON.stringify(item))).toMatchObject({ severity: 'Error', message: 'm' });
});
