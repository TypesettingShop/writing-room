import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { readExtensionEntry } from '../../services/extensions/common/extensionResources.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { MainThreadRuntimeShape } from '../common/extHost.protocol.runtime.js';
import type { IExtensionModule } from '../common/extHostExtensionActivator.js';

const nativeFetch = globalThis.fetch.bind(globalThis);
const NativeWorker = globalThis.Worker;
const nativeTerminate = NativeWorker.prototype.terminate;
const nativePost = NativeWorker.prototype.postMessage;
const evaluate = Function;
const createObjectURL = URL.createObjectURL.bind(URL);
const revokeObjectURL = URL.revokeObjectURL.bind(URL);
const allowedFetch = new Set(['http:', 'https:', 'data:', 'blob:']);
const nativeSource = Function.prototype.toString;
const globalMethods = new WeakMap<Function, Function>();

function isConstructor(value: Function): boolean {
  try {
    // Only checks [[Construct]] of the new target; `value` itself is not called.
    Reflect.construct(String, [], value);
    return true;
  } catch {
    return false;
  }
}

/** Platform methods such as setTimeout reject any receiver but the global, so a call through `self` runs on it. */
function globalValue(value: unknown): unknown {
  if (typeof value !== 'function' || isConstructor(value) || !nativeSource.call(value).endsWith('{ [native code] }')) {
    return value;
  }
  let method = globalMethods.get(value);
  if (!method) {
    method = value.bind(globalThis) as Function;
    globalMethods.set(value, method);
  }
  return method;
}

// The nested worker gets its own control port before any caller messages arrive.
const bootstrap = `
let queued = [];
const load = importScripts.bind(self);
const listen = addEventListener.bind(self);
const unlisten = removeEventListener.bind(self);
listen('message', function connect(event) {
  event.stopImmediatePropagation();
  const port = event.ports[0];
  function queue(event) {
    event.stopImmediatePropagation();
    queued.push(event);
  }
  listen('message', queue);
  port.onmessage = ({data: url}) => {
    port.close();
    const checkedImport = (...scripts) => {
      if (scripts.some(script => !/^[a-z][a-z0-9+.-]*:/i.test(String(script)))) {
        throw new Error('Relative importScripts paths are not supported in extension workers.');
      }
      load(...scripts);
    };
    for (let object = self; object && object !== EventTarget.prototype; object = Object.getPrototypeOf(object)) {
      if (object === self || Object.hasOwn(object, 'importScripts')) {
        Object.defineProperty(object, 'importScripts', { value: checkedImport });
      }
    }
    load(url);
    unlisten('message', queue);
    for (const event of queued) {
      dispatchEvent(new MessageEvent('message', {data: event.data, ports: event.ports}));
    }
    queued = [];
  };
}, { once: true });
`;

function resourceUrl(value: string | URL): URL {
  return new URL(String(value), globalThis.location.href);
}

export class ExtensionGlobals {
  private readonly workers = new Map<string, Map<Worker, () => void>>();

  constructor(private readonly main: MainThreadRuntimeShape) {}

  install(): void {
    const unscopedFetch: typeof fetch = (input, init) => this.fetch(undefined, input, init);
    const Worker = function (): never {
      throw new Error('Worker must be constructed in extension code.');
    };
    Object.defineProperty(Worker, 'prototype', { value: NativeWorker.prototype });
    Object.defineProperty(NativeWorker.prototype, 'constructor', { value: Worker, configurable: false, writable: false });
    for (const [name, value] of Object.entries({ fetch: unscopedFetch, Worker })) {
      for (let object = globalThis; object && object !== EventTarget.prototype; object = Object.getPrototypeOf(object)) {
        if (object === globalThis || Object.hasOwn(object, name)) {
          Object.defineProperty(object, name, { value, configurable: false, writable: false });
        }
      }
    }
  }

  private async fetch(key: string | undefined, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : undefined;
    const url = resourceUrl(request ? request.url : input as string | URL);
    if (allowedFetch.has(url.protocol)) {
      return nativeFetch(input, init);
    }
    if (!key) {
      throw new Error('Extension resources must be requested from extension code.');
    }
    const method = init?.method ?? request?.method ?? 'GET';
    if (!/^(GET|HEAD)$/i.test(method)) {
      throw new Error('Extension resources are read-only.');
    }
    // Validate the original spelling in the workbench before WHATWG URL normalization can hide it.
    const mapped = await this.main.$asBrowserUri(key, request ? request.url : String(input), false);
    return nativeFetch(mapped, { method, signal: request?.signal, headers: request?.headers, ...init });
  }

  private createWorker(key: string, input: string | URL, options?: WorkerOptions): Worker {
    if (options?.type === 'module') {
      throw new Error('Module workers are not supported in extensions.');
    }
    const url = resourceUrl(input);
    const direct = url.protocol === 'blob:' || (/^https?:$/.test(url.protocol) && url.origin === globalThis.location.origin);
    let bootstrapUrl: string | undefined;
    let port: MessagePort | undefined;
    let worker: Worker;
    let live = true;
    try {
      if (!direct) {
        bootstrapUrl = createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
      }
      worker = new NativeWorker(bootstrapUrl ?? url, options);
    } catch (error) {
      if (bootstrapUrl) {
        revokeObjectURL(bootstrapUrl);
      }
      throw error;
    }
    const owned = this.workers.get(key) ?? new Map<Worker, () => void>();
    this.workers.set(key, owned);
    const clearBootstrap = () => {
      if (bootstrapUrl) {
        revokeObjectURL(bootstrapUrl);
        bootstrapUrl = undefined;
      }
    };
    const terminate = () => {
      if (live) {
        live = false;
        port?.close();
        clearBootstrap();
        owned.delete(worker);
        nativeTerminate.call(worker);
      }
    };
    owned.set(worker, terminate);
    Object.defineProperty(worker, 'terminate', { value: terminate });
    if (!direct) {
      const channel = new MessageChannel();
      port = channel.port1;
      nativePost.call(worker, 'connect', { transfer: [channel.port2] });
      void this.main.$asBrowserUri(key, String(input), true).then(script => {
        if (live) {
          port?.postMessage(script);
        }
      }).catch(error => {
        if (live) {
          worker.dispatchEvent(new ErrorEvent('error', { message: error instanceof Error ? error.message : String(error) }));
          terminate();
        }
      });
    }
    return worker;
  }

  async load(extension: HostExtensionDescription, api: typeof vscode, signal: AbortSignal): Promise<IExtensionModule> {
    const bytes = await readExtensionEntry(URI.parse(extension.entry), signal);
    signal.throwIfAborted();
    const source = new TextDecoder().decode(bytes);
    const module = { exports: {} as IExtensionModule };
    const globals = this;
    const checkLive = () => {
      if (!this.workers.has(extension.key)) {
        throw new Error(`Extension '${extension.id}' is no longer active.`);
      }
    };
    this.workers.set(extension.key, new Map());
    const fetch: typeof globalThis.fetch = (input, init) => {
      try {
        checkLive();
        return globals.fetch(extension.key, input, init);
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const Worker = function (this: unknown, input: string | URL, options?: WorkerOptions): Worker {
      if (!new.target) {
        throw new TypeError('Worker must be called with new.');
      }
      checkLive();
      return globals.createWorker(extension.key, input, options);
    };
    Object.defineProperty(Worker, 'prototype', { value: NativeWorker.prototype });
    const scoped = new Proxy(Object.create(null) as typeof globalThis, {
      get(_target, key) {
        if (key === 'self' || key === 'globalThis') { return scoped; }
        if (key === 'fetch') { return fetch; }
        if (key === 'Worker') { return Worker; }
        return globalValue(Reflect.get(globalThis, key, globalThis));
      },
      has(_target, key) {
        return key === 'self' || key === 'globalThis' || Reflect.has(globalThis, key);
      },
      set(_target, key, value) {
        return Reflect.set(globalThis, key, value, globalThis);
      },
    });
    const require = (name: string): typeof vscode => {
      if (name === 'vscode') {
        return api;
      }
      throw new Error(`Cannot load module '${name}'`);
    };
    const run = evaluate('module', 'exports', 'require', 'fetch', 'Worker', 'globalThis', 'self',
      source + '\n//# sourceURL=' + extension.entry);
    run.call(scoped, module, module.exports, require, fetch, Worker, scoped, scoped);
    return module.exports ?? {};
  }

  release(key: string): void {
    const owned = this.workers.get(key);
    this.workers.delete(key);
    for (const terminate of owned?.values() ?? []) {
      terminate();
    }
  }

  dispose(): void {
    for (const key of this.workers.keys()) {
      this.release(key);
    }
  }
}
