const { commands } = require('vscode');

exports.activate = ({ subscriptions }) => {
  subscriptions.push(commands.registerCommand('host-fixture.async-error', () => {
    void Promise.reject(new Error('Fixture rejected promise'));
    setTimeout(() => { throw new Error('Fixture asynchronous error'); }, 0);
    return 'scheduled';
  }));
};
