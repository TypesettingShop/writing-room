import { expect, test, vi } from 'vitest';
import { OutputService } from '../../../contrib/output/browser/outputServices.js';
import { appendExtensionHostLog } from '../../browser/mainThreadRuntime.js';
import { boundExtensionHostLogLine, EXTENSION_HOST_LOG_LINE_LIMIT } from '../../common/extHost.protocol.runtime.js';

test('creates a shared plain-text workbench channel lazily and bounds each RPC write', () => {
  const openView = vi.fn();
  const output = new OutputService({ openView } as never, {} as never, {} as never, {} as never);
  const getOutput = vi.fn(() => output);
  const receiveFromFirstHost = (line: unknown) => appendExtensionHostLog(getOutput, line);
  expect(output.getChannelDescriptors()).toEqual([]);
  receiveFromFirstHost({ line: 'invalid RPC' });
  receiveFromFirstHost('');
  expect(getOutput).not.toHaveBeenCalled();

  const active = output.registerChannel({ id: 'existing', label: 'Existing', extensionId: 'test.owner' });
  receiveFromFirstHost('<b>first host</b>\n');
  const channel = output.getChannel('workerexthost')!;
  expect(channel.descriptor).toEqual({ id: 'workerexthost', label: 'Extension Host (Worker)' });
  expect(channel.model.getText()).toBe('<b>first host</b>\n');
  expect(output.getActiveChannel()).toBe(active);
  expect(openView).not.toHaveBeenCalled();

  const receiveFromNextHost = (line: unknown) => appendExtensionHostLog(getOutput, line);
  receiveFromNextHost('x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT) + 'discard this');
  // A cut line keeps its line feed, so the next one does not join it.
  receiveFromNextHost('next\n');
  expect(output.getChannel('workerexthost')).toBe(channel);
  expect(channel.model.getText())
    .toBe('<b>first host</b>\n' + 'x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 1) + '\nnext\n');
  expect(output.getActiveChannel()).toBe(active);
  expect(openView).not.toHaveBeenCalled();
});

test('cuts an over-long log line without splitting a surrogate pair', () => {
  const pair = '\u{1F600}';
  const line = 'x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 3) + pair + 'tail';
  expect(boundExtensionHostLogLine(line)).toBe('x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 3) + pair + '\n');
  const split = 'x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 2) + pair + 'tail';
  expect(boundExtensionHostLogLine(split)).toBe('x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 2) + '\n');
  const fits = 'x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT - 1) + '\n';
  expect(boundExtensionHostLogLine(fits)).toBe(fits);
});
