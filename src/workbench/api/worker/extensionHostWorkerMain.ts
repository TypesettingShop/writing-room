import { ExtensionHostMessage } from '../../services/extensions/common/extensionHostProtocol.js';
import type { HostControlMessage } from '../../services/extensions/common/extensionHostProtocol.js';
import { readPortMessageData, RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { ExtHostExtensionService } from '../common/extHostExtensionService.js';
import { MainThreadRuntimeProxy } from '../common/extHost.protocol.runtime.js';
import { logExtensionHostError, stopExtensionHostLogDelivery } from '../common/extHostRuntimeLog.js';
import { extHostApiRegistry } from '../common/extHostApiRegistry.js';
import { ExtensionGlobals } from './extHostGlobals.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const close = scope.close.bind(scope);
const enqueueMicrotask = scope.queueMicrotask.bind(scope);
const listen = scope.addEventListener.bind(scope);
const logError = console.error.bind(console);
const errorWithStackLimit = Error as ErrorConstructor & { stackTraceLimit?: number };
if (typeof errorWithStackLimit.stackTraceLimit === 'number' && errorWithStackLimit.stackTraceLimit < 100) {
  errorWithStackLimit.stackTraceLimit = 100;
}

for (const key of ['postMessage', 'close', 'importScripts', 'addEventListener', 'onmessage', 'onmessageerror']) {
  // Clear the worker-specific prototype slots as well as the instance's property lookup.
  for (let object = Object.getPrototypeOf(scope); object && object !== EventTarget.prototype; object = Object.getPrototypeOf(object)) {
    if (Object.hasOwn(object, key)) {
      Object.defineProperty(object, key, { value: undefined, configurable: false, writable: false });
    }
  }
  Object.defineProperty(scope, key, { value: undefined, configurable: false, writable: false });
}

listen('message', ({ data, ports }) => {
  const port = ports[0];
  if (data !== 'connect' || !port) {
    close();
    return;
  }
  const send = port.postMessage.bind(port);
  const rpc = new RPCProtocol(port);
  let service: ExtHostExtensionService | undefined;
  port.addEventListener('message', event => {
    // Control messages stay behind this port when extension code runs in the same realm.
    const data = readPortMessageData(event) as HostControlMessage;
    if (data.kind === ExtensionHostMessage.Initialize && !service) {
      const main = rpc.getProxy(MainThreadRuntimeProxy);
      const globals = new ExtensionGlobals(main);
      globals.install();
      extHostApiRegistry.register('workerGlobals', () => ({
        release: key => globals.release(key),
        dispose: () => globals.dispose(),
      }));
      service = new ExtHostExtensionService(rpc, (extension, api, signal) => globals.load(extension, api, signal));
      void service.$deltaExtensions(data.extensions, []).then(() => {
        // Initialization errors can still reach the workbench. Extension callbacks start after this handshake.
        const reportError = (message: string, error: unknown) => {
          const id = globals.extensionForError(error);
          if (id) {
            logExtensionHostError(rpc, main, id, message, error);
          } else {
            logError(message, error);
          }
        };
        listen('error', event => {
          event.preventDefault();
          reportError('Uncaught error in the extension worker:', event.error ?? event.message);
        });
        listen('unhandledrejection', event => {
          event.preventDefault();
          reportError('Unhandled promise rejection in the extension worker:', event.reason);
        });
        send({ kind: ExtensionHostMessage.Initialized });
      });
    } else if (data.kind === ExtensionHostMessage.Ping) {
      send({ kind: ExtensionHostMessage.Pong, sequence: data.sequence });
    } else if (data.kind === ExtensionHostMessage.Terminate) {
      // The workbench has stopped accepting RPC by the time it handles the cleanup messages.
      stopExtensionHostLogDelivery(rpc);
      try {
        service?.dispose();
        // An already rejected deactivate promise gets to report before the workbench terminates this Worker.
        enqueueMicrotask(() => send({ kind: ExtensionHostMessage.Terminated }));
      } finally {
        enqueueMicrotask(() => {
          rpc.dispose();
          close();
        });
      }
    }
  });
  send({ kind: ExtensionHostMessage.Ready });
}, { once: true });
