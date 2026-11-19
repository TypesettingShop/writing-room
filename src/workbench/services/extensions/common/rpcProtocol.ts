import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { marshal, revive } from '../../../../base/common/marshalling.js';
import type { ProxyIdentifier } from './proxyIdentifier.js';

const messageDataGetter = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')?.get;
export const readPortMessageData = messageDataGetter
  ? Function.prototype.call.bind(messageDataGetter) as (event: MessageEvent) => unknown
  : (event: MessageEvent) => event.data;

interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
}

type Request = {
  kind: 'request';
  id: number;
  proxy: string;
  method: string;
  args: unknown[];
  cancellation?: 'pending' | 'cancelled';
};
type Cancel = { kind: 'cancel'; id: number };
type Response = { kind: 'reply'; id: number; value: unknown } | { kind: 'error'; id: number; error: SerializedError };
type RpcMessage = Request | Response | Cancel;

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cancellation?: IDisposable;
}

function serializeError(error: unknown): SerializedError {
  try {
    if (error instanceof Error) {
      const { code } = error as Error & { code?: unknown };
      return {
        name: String(error.name), message: String(error.message), stack: String(error.stack ?? ''),
        code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
      };
    }
    return { name: 'Error', message: String(error) };
  } catch {
    return { name: 'Error', message: 'The remote call threw an error that could not be serialized.' };
  }
}

function isMessage(data: unknown): data is RpcMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const message = data as Partial<RpcMessage>;
  if (!Number.isSafeInteger(message.id)) {
    return false;
  }
  switch (message.kind) {
    case 'request':
      return typeof message.proxy === 'string' && typeof message.method === 'string' && Array.isArray(message.args)
        && (message.cancellation === undefined || message.cancellation === 'pending' || message.cancellation === 'cancelled');
    case 'cancel':
    case 'reply':
      return true;
    case 'error': {
      const error = message.error;
      return !!error && typeof error.name === 'string' && typeof error.message === 'string'
        && (error.stack === undefined || typeof error.stack === 'string')
        && (error.code === undefined || typeof error.code === 'string' || typeof error.code === 'number');
    }
    default:
      return false;
  }
}

export class RPCProtocol {
  private readonly pending = new Map<number, PendingCall>();
  private readonly incoming = new Map<number, CancellationTokenSource | undefined>();
  private readonly handlers = new Map<string, Map<string, (...args: unknown[]) => unknown>>();
  private readonly send: (value: RpcMessage, transfer: ArrayBuffer[]) => void;
  private readonly close: () => void;
  private nextId = 0;
  private stopped?: Error;

  constructor(port: MessagePort) {
    this.send = port.postMessage.bind(port);
    this.close = port.close.bind(port);
    port.addEventListener('message', event => {
      const message = readPortMessageData(event);
      if (isMessage(message)) {
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
      const pending: PendingCall = { resolve, reject };
      this.pending.set(id, pending);
      try {
        const last = args.at(-1);
        const token = CancellationToken.isCancellationToken(last) ? last : undefined;
        const { value, transfer } = marshal(token ? args.slice(0, -1) : args);
        const cancellation = token && (token.isCancellationRequested ? 'cancelled' : 'pending');
        this.send({ kind: 'request', id, proxy, method, args: value as unknown[], cancellation }, transfer);
        if (cancellation === 'pending') {
          pending.cancellation = token!.onCancellationRequested(() => {
            if (this.pending.get(id) === pending) {
              this.send({ kind: 'cancel', id }, []);
            }
          });
        }
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
    if (message.kind === 'cancel') {
      this.incoming.get(message.id)?.cancel();
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    pending.cancellation?.dispose();
    if (message.kind === 'reply') {
      try {
        pending.resolve(revive(message.value));
      } catch (error) {
        pending.reject(error);
      }
    } else {
      const error = new Error(message.error.message);
      error.name = message.error.name;
      error.stack = message.error.stack;
      if (message.error.code !== undefined) {
        Object.assign(error, { code: message.error.code });
      }
      pending.reject(error);
    }
  }

  private async invoke({ id, proxy, method, args, cancellation }: Request): Promise<void> {
    if (this.incoming.has(id)) {
      return;
    }
    const source = cancellation ? new CancellationTokenSource() : undefined;
    if (cancellation === 'cancelled') {
      source!.cancel();
    }
    this.incoming.set(id, source);
    try {
      const handler = this.handlers.get(proxy)?.get(method);
      if (!handler) {
        throw new Error(`Unknown RPC method '${proxy}.${method}'.`);
      }
      const revived = revive(args) as unknown[];
      if (source) {
        revived.push(source.token);
      }
      // Start the handler in this message turn. Its asynchronous result does not block later requests.
      const result = await handler(...revived);
      if (!this.stopped) {
        const { value, transfer } = marshal(result);
        this.send({ kind: 'reply', id, value }, transfer);
      }
    } catch (error) {
      if (!this.stopped) {
        this.send({ kind: 'error', id, error: serializeError(error) }, []);
      }
    } finally {
      this.incoming.delete(id);
      source?.dispose();
    }
  }

  dispose(reason = new Error('The extension host is not running.')): void {
    if (this.stopped) {
      return;
    }
    this.stopped = reason;
    this.close();
    for (const call of this.pending.values()) {
      call.cancellation?.dispose();
      call.reject(reason);
    }
    for (const source of this.incoming.values()) {
      source?.dispose(true);
    }
    this.incoming.clear();
    this.pending.clear();
    this.handlers.clear();
  }
}
