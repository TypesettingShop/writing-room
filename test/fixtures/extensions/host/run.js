const vscode = require('vscode');

exports.activate = context => {
  let requireError;
  try {
    require('unsupported');
  } catch (error) {
    requireError = error.message;
  }
  // Extension code shares the host's realm. A replaced MessageEvent getter must never see the host's port.
  let portReached = false;
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data');
  Object.defineProperty(MessageEvent.prototype, 'data', {
    ...data,
    get() {
      portReached ||= this.currentTarget instanceof MessagePort || this.target instanceof MessagePort;
      return data.get.call(this);
    },
  });
  context.subscriptions.push(vscode.commands.registerCommand('host-fixture.run', () => ({
    worker: typeof WorkerGlobalScope === 'function',
    document: typeof globalThis.document,
    storage: typeof globalThis.localStorage,
    postMessage: typeof globalThis.postMessage,
    close: typeof globalThis.close,
    importScripts: typeof globalThis.importScripts,
    addEventListener: typeof globalThis.addEventListener,
    requireError,
    portReached,
  })));
};
