// @vitest-environment node
import { expect, test } from 'vitest';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { createProxyIdentifier, TransferableBuffer } from '../../common/proxyIdentifier.js';
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

test('transports URIs through cyclic records, and copies or transfers buffers as requested', async () => {
  const channel = new MessageChannel();
  const client = new RPCProtocol(channel.port1);
  const server = new RPCProtocol(channel.port2);
  const transport = createProxyIdentifier<{
    $roundtrip(value: unknown): Promise<unknown>;
    $transfer(value: unknown): Promise<unknown>;
  }>('transport');
  server.set(transport, {
    async $roundtrip(value) {
      const record = value as { self: unknown; nested: [URI]; uri: URI; bytes: Uint8Array };
      expect(record.self).toBe(value);
      expect(record.nested[0]).toBe(record.uri);
      expect(record.uri).toBeInstanceOf(URI);
      return record;
    },
    async $transfer(value) { return new TransferableBuffer(value as Uint8Array); },
  });
  try {
    const remote = client.getProxy(transport);
    const uri = URI.from({ scheme: 'sample', authority: 'workbench', path: '/document' });
    const bytes = Uint8Array.of(1, 2, 3);
    const record = { uri, nested: [uri], bytes, self: undefined as unknown };
    record.self = record;
    const copy = await remote.$roundtrip(record) as typeof record;
    expect(copy.self).toBe(copy);
    expect(copy.nested[0]).toBe(copy.uri);
    expect(copy.uri).toBeInstanceOf(URI);
    expect(copy.uri.toJSON()).toEqual(uri.toJSON());
    expect(copy.bytes).toEqual(bytes);
    expect(bytes.byteLength).toBe(3);
    const received = await remote.$transfer(new TransferableBuffer(bytes));
    expect(bytes.byteLength).toBe(0);
    expect(received).toEqual(Uint8Array.of(1, 2, 3));
  } finally {
    client.dispose();
    server.dispose();
  }
});

test('delivers cancellation cooperatively and ignores it after a call settles', async () => {
  const channel = new MessageChannel();
  const client = new RPCProtocol(channel.port1);
  const server = new RPCProtocol(channel.port2);
  const entered = new DeferredPromise<void>();
  const cancelled = new DeferredPromise<void>();
  const finish = new DeferredPromise<void>();
  const cancellation = createProxyIdentifier<{
    $wait(token: CancellationToken): Promise<string>;
    $isCancelled(token: CancellationToken): Promise<boolean>;
    $stuck(token: CancellationToken): Promise<void>;
  }>('cancellation');
  server.set(cancellation, {
    async $wait(token) {
      const listener = token.onCancellationRequested(() => { void cancelled.complete(); });
      await entered.complete();
      await finish.p;
      listener.dispose();
      return token.isCancellationRequested ? 'cancelled' : 'completed';
    },
    async $isCancelled(token) { return token.isCancellationRequested; },
    $stuck: () => new Promise(() => {}),
  });
  try {
    const remote = client.getProxy(cancellation);
    const source = new CancellationTokenSource();
    const result = remote.$wait(source.token);
    await entered.p;
    source.cancel();
    await cancelled.p;
    expect(await Promise.race([result, Promise.resolve('still waiting')])).toBe('still waiting');
    await finish.complete();
    await expect(result).resolves.toBe('cancelled');
    await expect(remote.$isCancelled(CancellationToken.Cancelled)).resolves.toBe(true);
    const late = new CancellationTokenSource();
    await expect(remote.$isCancelled(late.token)).resolves.toBe(false);
    late.cancel();
    await expect(remote.$isCancelled(CancellationToken.None)).resolves.toBe(false);
    const stuck = remote.$stuck(source.token);
    client.dispose();
    await expect(stuck).rejects.toThrow('The extension host is not running');
  } finally {
    client.dispose();
    server.dispose();
  }
});

test('starts 100 requests in order before waiting for their replies', async () => {
  const channel = new MessageChannel();
  const client = new RPCProtocol(channel.port1);
  const server = new RPCProtocol(channel.port2);
  const order = createProxyIdentifier<{ $notify(index: number): Promise<void> }>('order');
  const allStarted = new DeferredPromise<void>();
  const finish = new DeferredPromise<void>();
  const started: number[] = [];
  server.set(order, {
    async $notify(index) {
      started.push(index);
      if (started.length === 100) {
        await allStarted.complete();
      }
      await finish.p;
    },
  });
  try {
    const remote = client.getProxy(order);
    const expected = Array.from({ length: 100 }, (_, index) => index);
    const completed = Promise.all(expected.map(index => remote.$notify(index)));
    await allStarted.p;
    expect(started).toEqual(expected);
    await finish.complete();
    await completed;
  } finally {
    client.dispose();
    server.dispose();
  }
});

test('rejects a bad payload locally, preserves error codes and ignores malformed envelopes', async () => {
  const channel = new MessageChannel();
  const client = new RPCProtocol(channel.port1);
  const server = new RPCProtocol(channel.port2);
  const safe = createProxyIdentifier<{ $echo(value: unknown): Promise<unknown>; $fail(): Promise<void> }>('safe');
  server.set(safe, {
    async $echo(value) { return value; },
    async $fail() { throw Object.assign(new Error('missing'), { name: 'FileSystemError', code: 'FileNotFound' }); },
  });
  try {
    const remote = client.getProxy(safe);
    channel.port1.postMessage({ kind: 'request', id: 999, proxy: 'safe', method: '$echo', args: 3 });
    channel.port2.postMessage({ kind: 'error', id: 1, error: null });
    await expect(remote.$echo('valid')).resolves.toBe('valid');
    await expect(remote.$fail()).rejects.toMatchObject({ name: 'FileSystemError', code: 'FileNotFound' });
    await expect(remote.$echo({ $mid: 1, scheme: false })).rejects.toThrow('Invalid RPC URI');
    let deep: unknown = 'leaf';
    for (let i = 0; i < 250; i++) {
      deep = { child: deep };
    }
    await expect(remote.$echo(deep)).rejects.toThrow('nested too deeply');
    await expect(remote.$echo('still working')).resolves.toBe('still working');
  } finally {
    client.dispose();
    server.dispose();
  }
});
