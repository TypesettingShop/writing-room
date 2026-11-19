const vscode = require('vscode');
const sourceMessage = vscode.l10n.t('Welcome {name}', { name: 'Runtime' });

exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('runtime.globals', async () => {
    const workerGlobalMethods = 'fetch' in self && 'Worker' in globalThis
      && await new Promise(resolve => self.setTimeout(() => resolve(
        globalThis.structuredClone({ text: self.atob('b2s=') }).text === 'ok'), 0));
    const address = path => vscode.Uri.joinPath(context.extensionUri, path).toString();
    const result = await fetch(address('data.json')).then(response => response.json());
    const worker = new self.Worker(address('worker.js'));
    const received = [];
    const ordered = new Promise((resolve, reject) => {
      worker.addEventListener('message', ({ data }) => {
        received.push(data);
        if (received.length === 2) {
          resolve(received.join(','));
        }
      });
      worker.addEventListener('error', event => { event.preventDefault(); reject(new Error(event.message)); });
    });
    worker.postMessage('one');
    worker.postMessage('two');
    const messages = await ordered;
    worker.terminate();
    let taskCalled = false;
    const execution = new vscode.CustomExecution(() => { taskCalled = true; });
    const task = new vscode.Task({ type: 'fixture' }, vscode.TaskScope.Workspace, 'Fixture', 'fixture', execution);
    context.subscriptions.push(vscode.tasks.registerTaskProvider('fixture', { provideTasks: () => [task] }));
    const taskRejected = await vscode.tasks.executeTask(task).then(() => false, () => true);
    const folderDenied = await fetch('vscode-userdata:/User/globalStorage/test.runtime-globals/secret.json')
      .then(() => false, () => true);
    await vscode.window.showInformationMessage([
      vscode.env.language, sourceMessage, context.extension.packageJSON.contributes.commands[0].title,
      result.label, messages, taskRejected, taskCalled, folderDenied, typeof vscode.debug,
      typeof self.postMessage, typeof self.close, typeof self.importScripts, workerGlobalMethods,
    ].join(' | '));
  }));
};
