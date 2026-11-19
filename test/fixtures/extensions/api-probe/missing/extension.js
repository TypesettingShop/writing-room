// Reads one member that no API version has while loading and calls another one while activating.
const vscode = require('vscode');
const namespace = vscode.noSuchNamespace;
exports.activate = () => {
  vscode.window.noSuch(namespace);
};
