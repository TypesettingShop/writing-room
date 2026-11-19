const vscode = acquireVsCodeApi();
const text = document.getElementById('text');
document.getElementById('append').addEventListener('click', () => vscode.postMessage({ type: 'append' }));
document.getElementById('fail')?.addEventListener('click', () => vscode.postMessage({ type: 'fail' }));
window.addEventListener('message', event => {
  if (event.data && typeof event.data.text === 'string') {
    text.textContent = event.data.text;
  }
});
