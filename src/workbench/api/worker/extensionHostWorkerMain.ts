import { ExtensionHostMessage } from '../../services/extensions/common/extensionHostProtocol.js';
import type { HostControlMessage } from '../../services/extensions/common/extensionHostProtocol.js';
import { RPCProtocol } from '../../services/extensions/common/rpcProtocol.js';
import { ExtHostExtensionService } from '../common/extHostExtensionService.js';
import { loadCommonJSModule } from './extHostExtensionService.js';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
const close = scope.close.bind(scope);
const listen = scope.addEventListener.bind(scope);

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
  port.addEventListener('message', ({ data }: MessageEvent<HostControlMessage>) => {
    if (data.kind === ExtensionHostMessage.Initialize && !service) {
      service = new ExtHostExtensionService(rpc, loadCommonJSModule);
      void service.$deltaExtensions(data.extensions, []).then(() => send({ kind: ExtensionHostMessage.Initialized }));
    } else if (data.kind === ExtensionHostMessage.Ping) {
      send({ kind: ExtensionHostMessage.Pong, sequence: data.sequence });
    } else if (data.kind === ExtensionHostMessage.Terminate) {
      service?.dispose();
      rpc.dispose();
      close();
    }
  });
  send({ kind: ExtensionHostMessage.Ready });
}, { once: true });
