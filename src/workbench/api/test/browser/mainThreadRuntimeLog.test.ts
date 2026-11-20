import { expect, test, vi } from 'vitest';
import { OutputService } from '../../../contrib/output/browser/outputServices.js';
import { appendExtensionHostLog } from '../../browser/mainThreadRuntime.js';
import { EXTENSION_HOST_LOG_LINE_LIMIT } from '../../common/extHost.protocol.runtime.js';

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
  expect(output.getChannel('workerexthost')).toBe(channel);
  expect(channel.model.getText()).toBe('<b>first host</b>\n' + 'x'.repeat(EXTENSION_HOST_LOG_LINE_LIMIT));
  expect(output.getActiveChannel()).toBe(active);
  expect(openView).not.toHaveBeenCalled();
});
