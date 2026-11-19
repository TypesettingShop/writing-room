const api = acquireVsCodeApi();
function forbidden(read) {
  try { read(); return false; } catch { return true; }
}
api.postMessage({
  resource: true,
  documentBlocked: forbidden(() => top.document),
  storageBlocked: forbidden(() => top.localStorage),
  singleAcquire: forbidden(() => acquireVsCodeApi()),
});
window.addEventListener('message', event => {
  if (event.source === parent && event.origin === location.origin) {
    api.postMessage(event.data);
  }
});
