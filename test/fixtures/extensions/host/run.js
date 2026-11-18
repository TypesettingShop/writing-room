const vscode = require('vscode');

exports.activate = context => {
  let requireError;
  try {
    require('unsupported');
  } catch (error) {
    requireError = error.message;
  }
  context.subscriptions.push(vscode.commands.registerCommand('host-fixture.run', () => ({
    worker: typeof WorkerGlobalScope === 'function',
    document: typeof globalThis.document,
    storage: typeof globalThis.localStorage,
    postMessage: typeof globalThis.postMessage,
    close: typeof globalThis.close,
    importScripts: typeof globalThis.importScripts,
    addEventListener: typeof globalThis.addEventListener,
    requireError,
  })));
};
