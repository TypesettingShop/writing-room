// @vitest-environment node
import type * as vscode from 'vscode';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { MarkerService } from '../../../../platform/markers/common/markerService.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { checkMarkers, MainThreadDiagnostics, MAX_MESSAGE_LENGTH, sanitizeMarker } from '../../browser/mainThreadDiagnostics.js';
import type { ExtHostDiagnosticsShape } from '../../common/extHost.protocol.diagnostics.js';
import { ExtHostDiagnosticsProxy, MainThreadDiagnosticsProxy } from '../../common/extHost.protocol.diagnostics.js';
import { Diagnostic, DiagnosticSeverity, DIAGNOSTICS_EVENT_DELAY, ExtHostDiagnostics } from '../../common/extHostDiagnostics.js';
import { Range } from '../../common/extHostEditorTypes.js';
import { createTestRpcPair } from '../common/testExtensionHost.js';

const extensions = new Map([['1', 'test.first'], ['2', 'test.second']]);
const resource = URI.parse('untitled:Untitled-1');
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
let disposables: DisposableStore;

beforeEach(() => { disposables = new DisposableStore(); });
afterEach(() => disposables.dispose());

function setup(proxy: ExtHostDiagnosticsShape = { $acceptMarkersChange: async () => {} }) {
  const markers = disposables.add(new MarkerService());
  const main = disposables.add(new MainThreadDiagnostics(proxy, markers, key => extensions.get(key)));
  return { markers, main };
}

const marker = (message: string, severity = MarkerSeverity.Error) =>
  ({ message, severity, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 });

test('checks what the extension host sends: ranges, severities, lengths, tags and link schemes', () => {
  expect(sanitizeMarker({
    message: 'x'.repeat(MAX_MESSAGE_LENGTH + 5), severity: 99, source: 7,
    startLineNumber: 4, startColumn: 9, endLineNumber: -2, endColumn: Number.POSITIVE_INFINITY,
    tags: [1, 1, 2, 3, 'x'], code: { value: 'MD001', target: URI.parse('javascript:alert(1)') },
    relatedInformation: [{ resource: URI.parse('untitled:Untitled-2'), message: 'see', startLineNumber: 0 }, { message: 'no resource' }],
    extra: 'dropped',
  })).toEqual({
    message: 'x'.repeat(MAX_MESSAGE_LENGTH) + '…', severity: MarkerSeverity.Error,
    startLineNumber: 1, startColumn: 1, endLineNumber: 4, endColumn: 9,
    tags: [1, 2], code: 'MD001',
    relatedInformation: [{
      resource: URI.parse('untitled:Untitled-2'), message: 'see', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1,
    }],
  });
  for (const target of ['https://example.test/rule', 'http://example.test/', 'vscode-vfs://writing-room/workspace/a.md']) {
    expect(sanitizeMarker({ ...marker('m'), code: { value: 'c', target: URI.parse(target) } })?.code)
      .toEqual({ value: 'c', target: URI.parse(target) });
  }
  for (const target of ['javascript:alert(1)', 'data:text/html,x', 'untitled:Untitled-1', 'not a uri']) {
    expect(sanitizeMarker({ ...marker('m'), code: { value: 'c', target } })?.code).toBe('c');
  }
  expect(sanitizeMarker({ ...marker(''), severity: MarkerSeverity.Hint })).toBeUndefined();
  expect(sanitizeMarker(null)).toBeUndefined();
});

test('a list longer than the host sends keeps the most severe markers and the note', () => {
  const list = [
    ...Array.from({ length: 1200 }, () => marker('hint', MarkerSeverity.Hint)),
    ...Array.from({ length: 900 }, () => marker('error')),
  ];
  const checked = checkMarkers(list);
  expect(checked).toHaveLength(1001);
  expect(checked.filter(item => item.message === 'error')).toHaveLength(900);
  expect(checked.at(-1)).toMatchObject({ severity: MarkerSeverity.Info, message: 'Not showing 1100 further errors and warnings.' });
});

test('one extension cannot clear another extension\'s collection of the same name, and removal clears its own', async () => {
  const { markers, main } = setup();
  await main.$changeMany('1', 'lint', [[resource, [marker('first')]]]);
  await main.$changeMany('2', 'lint', [[resource, [marker('second')]]]);
  await main.$changeMany('2', 'other', [[resource, [marker('other')]]]);
  expect(markers.read({ resource }).map(item => item.owner)).toEqual(['test.first:lint', 'test.second:lint', 'test.second:other']);

  await main.$clear('1', 'lint');
  expect(markers.read({ resource }).map(item => item.message)).toEqual(['second', 'other']);

  main.remove('2');
  expect(markers.read()).toEqual([]);

  await expect(main.$changeMany('9', 'lint', [])).rejects.toThrow('The extension is not registered.');
  await expect(main.$changeMany('1', 'x'.repeat(300), [])).rejects.toThrow('Expected a diagnostic collection name.');
  // Entries without a usable resource are skipped, the rest still land.
  await main.$changeMany('1', 'lint', [[{ scheme: 'not a scheme' } as never, [marker('lost')]], 'junk' as never, [resource, [marker('kept')]]]);
  expect(markers.read().map(item => item.message)).toEqual(['kept']);
  main.dispose();
  expect(markers.read()).toEqual([]);
});

test('changes from owners outside the host reach it; its own changes do not echo', async () => {
  const sent: string[] = [];
  const { markers, main } = setup({
    $acceptMarkersChange: async data => { sent.push(data.map(([uri, items]) => uri + '=' + items.map(item => item.message).join()).join(' ')); },
  });
  await main.$changeMany('1', 'lint', [[resource, [marker('own')]]]);
  await tick();
  expect(sent).toEqual([]);

  markers.changeOne('workbench.json', resource, [marker('foreign')]);
  await tick();
  expect(sent).toEqual(['untitled:Untitled-1=foreign']);
  markers.changeOne('workbench.json', resource, []);
  await tick();
  expect(sent).toEqual(['untitled:Untitled-1=foreign', 'untitled:Untitled-1=']);
});

test('an extension\'s collection reaches the marker service over RPC, limited, and leaves it when the host stops', async () => {
  const pair = createTestRpcPair();
  disposables.add({ dispose: () => pair.dispose() });
  const markers = disposables.add(new MarkerService());
  const main = new MainThreadDiagnostics(pair.main.getProxy(ExtHostDiagnosticsProxy), markers, key => extensions.get(key));
  pair.main.set(MainThreadDiagnosticsProxy, main);
  const host = disposables.add(new ExtHostDiagnostics(pair.worker.getProxy(MainThreadDiagnosticsProxy)));
  pair.worker.set(ExtHostDiagnosticsProxy, host);
  const changes: string[][] = [];
  host.onDidChangeDiagnostics('1')(event => changes.push(event.uris.map(String)));

  const collection = host.createDiagnosticCollection('1', 'lint');
  const uri = resource as unknown as vscode.Uri;
  collection.set(uri, [
    ...Array.from({ length: 1400 }, (_, line) => new Diagnostic(new Range(line, 0, line, 1), 'hint', DiagnosticSeverity.Hint)),
    ...Array.from({ length: 100 }, (_, line) => new Diagnostic(new Range(line, 4, line, 2), 'error')),
  ]);
  await vi.waitFor(() => expect(markers.read({ resource })).toHaveLength(1001));
  const read = markers.read({ resource });
  expect(read.filter(item => item.severity === MarkerSeverity.Error)).toHaveLength(100);
  expect(read.at(-1)?.message).toBe('Not showing 500 further errors and warnings.');
  // Errors come first; the range the extension gave reversed arrives in order.
  expect(read[0]).toMatchObject({ severity: MarkerSeverity.Error, startColumn: 3, endColumn: 5 });
  await vi.waitFor(() => expect(changes).toEqual([['untitled:Untitled-1']]), { timeout: DIAGNOSTICS_EVENT_DELAY * 20 });

  main.dispose();
  expect(markers.read()).toEqual([]);
});
