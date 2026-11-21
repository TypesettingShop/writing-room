const api = acquireVsCodeApi();
const output = document.getElementById('count');
let count = api.getState()?.count ?? 0;
output.textContent = String(count);
document.querySelector('button').addEventListener('click', () => {
  output.textContent = String(++count);
  api.setState({ count });
});
window.addEventListener('message', ({ data }) => {
  if (Array.isArray(data)) {
    document.getElementById('visibility').textContent = JSON.stringify(data);
  }
});
