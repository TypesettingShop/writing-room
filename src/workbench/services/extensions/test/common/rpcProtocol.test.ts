// @vitest-environment node
import { expect, test } from 'vitest';
import { createProxyIdentifier } from '../../common/proxyIdentifier.js';
import { RPCProtocol } from '../../common/rpcProtocol.js';

const api = createProxyIdentifier<{
  $echo(input: unknown): Promise<unknown>;
  $fails(): Promise<unknown>;
  $invalidResult(): Promise<unknown>;
  $wait(): Promise<unknown>;
  privateMethod(): Promise<unknown>;
}>('test');

test('routes only RPC methods, preserves errors and settles invalid clones and stopped requests', async () => {
  const channel = new MessageChannel();
  const client = new RPCProtocol(channel.port1);
  const server = new RPCProtocol(channel.port2);
  server.set(api, {
    async $echo(value) { return value; },
    async $fails() { throw new TypeError('bad callback'); },
    async $invalidResult() { return () => {}; },
    $wait: () => new Promise(() => {}),
    async privateMethod() { throw new Error('must never reach this'); },
  });
  try {
    const proxy = client.getProxy(api);
    expect(await proxy.$echo(new Set([1]))).toEqual(new Set([1]));
    await expect(proxy.$fails()).rejects.toMatchObject({ name: 'TypeError', message: 'bad callback' });
    await expect(proxy.$invalidResult()).rejects.toMatchObject({ name: 'DataCloneError' });
    await expect(proxy.$echo(() => {})).rejects.toMatchObject({ name: 'DataCloneError' });
    const unknown = client.getProxy(createProxyIdentifier<{ $unknown(): Promise<void> }>(api.id));
    await expect(unknown.$unknown()).rejects.toThrow('Unknown RPC method');
    expect(proxy.privateMethod).toBeUndefined();
    channel.port2.postMessage({ kind: 'reply', id: -1, value: 'unknown request' });
    const reply = new Promise(resolve => {
      channel.port1.addEventListener('message', ({ data }) => {
        if (data.id === -2) { resolve(data); }
      });
    });
    channel.port1.postMessage({ kind: 'request', id: -2, proxy: api.id, method: 'privateMethod', args: [] });
    expect(await reply).toMatchObject({ kind: 'error', error: { message: expect.stringContaining('Unknown RPC method') } });
    const waiting = proxy.$wait();
    client.dispose();
    await expect(waiting).rejects.toThrow('The extension host is not running');
  } finally {
    client.dispose();
    server.dispose();
  }
});
