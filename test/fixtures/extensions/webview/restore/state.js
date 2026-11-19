const api = acquireVsCodeApi();
let count = api.getState()?.count ?? 0;
const output = document.getElementById('counter');
output.textContent = String(count);
document.getElementById('increment').addEventListener('click', () => {
  output.textContent = String(++count);
  api.setState({ count });
});
document.getElementById('oversize').addEventListener('click', () => {
  api.setState({ count: 999, data: 'x'.repeat(256 * 1024) });
});
