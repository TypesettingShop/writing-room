import type { ProxyIdentifier } from './proxyIdentifier.js';

const messageDataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
export const readPortMessageData = messageDataGetter
  ? Function.prototype.call.bind(messageDataGetter) as (event: MessageEvent) => unknown
  : (event: MessageEvent) => event.data;

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

type Request = { kind: 'request'; id: number; proxy: string; method: string; args: unknown[] };
type Response = { kind: 'reply'; id: number; value: unknown } | { kind: 'error'; id: number; error: SerializedError };
type RpcMessage = Request | Response;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function serializeError(error: unknown): SerializedError {
  try {
    if (error instanceof Error) {
      return { name: String(error.name), message: String(error.message), stack: String(error.stack ?? '') };
    }
    return { name: 'Error', message: String(error) };
  } catch {
    return { name: 'Error', message: 'The remote call threw an error that could not be serialized.' };
  }
}

export class RPCProtocol {
  private readonly pending = new Map<number, PendingCall>();
  private readonly handlers = new Map<string, Map<string, (...args: unknown[]) => unknown>>();
  private readonly send: (value: RpcMessage) => void;
  private readonly close: () => void;
  private nextId = 0;
  private stopped?: Error;

  constructor(port: MessagePort) {
    this.send = port.postMessage.bind(port);
    this.close = port.close.bind(port);
    port.addEventListener('message', event => {
      const message = readPortMessageData(event) as RpcMessage | undefined;
      if (message?.kind === 'request' || message?.kind === 'reply' || message?.kind === 'error') {
        this.receive(message);
      }
    });
    port.addEventListener('messageerror', () => this.dispose(new Error('Extension host RPC could not read a message.')));
    port.addEventListener('close', () => this.dispose());
    port.start();
  }

  getProxy<T extends object>(identifier: ProxyIdentifier<T>): T {
    return new Proxy(Object.create(null) as T, {
      get: (_target, method) => typeof method === 'string' && method.startsWith('$')
        ? (...args: unknown[]) => this.call(identifier.id, method, args)
        : undefined,
    });
  }

  set<T extends object>(identifier: ProxyIdentifier<T>, instance: T): void {
    if (this.handlers.has(identifier.id)) {
      throw new Error(`RPC proxy '${identifier.id}' already exists.`);
    }
    const methods = new Map<string, (...args: unknown[]) => unknown>();
    for (let object: object | null = instance; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
      for (const key of Object.getOwnPropertyNames(object)) {
        if (!key.startsWith('$') || methods.has(key)) {
          continue;
        }
        const value = Object.getOwnPropertyDescriptor(object, key)?.value;
        if (typeof value === 'function') {
          methods.set(key, value.bind(instance));
        }
      }
    }
    this.handlers.set(identifier.id, methods);
  }

  private call(proxy: string, method: string, args: unknown[]): Promise<unknown> {
    if (this.stopped) {
      return Promise.reject(this.stopped);
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ kind: 'request', id, proxy, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: RpcMessage): void {
    if (this.stopped) {
      return;
    }
    if (message.kind === 'request') {
      void this.invoke(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.kind === 'reply') {
      pending.resolve(message.value);
    } else {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      error.stack = message.error.stack;
      pending.reject(error);
    }
  }

  private async invoke({ id, proxy, method, args }: Request): Promise<void> {
    try {
      const handler = this.handlers.get(proxy)?.get(method);
      if (!handler) {
        throw new Error(`Unknown RPC method '${proxy}.${method}'.`);
      }
      const value = await handler(...args);
      if (!this.stopped) {
        this.send({ kind: 'reply', id, value });
      }
    } catch (error) {
      if (!this.stopped) {
        this.send({ kind: 'error', id, error: serializeError(error) });
      }
    }
  }

  dispose(reason = new Error('The extension host is not running.')): void {
    if (this.stopped) {
      return;
    }
    this.stopped = reason;
    this.close();
    for (const call of this.pending.values()) {
      call.reject(reason);
    }
    this.pending.clear();
    this.handlers.clear();
  }
}
