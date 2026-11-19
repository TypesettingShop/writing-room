const api = acquireVsCodeApi();
function forbidden(read) {
  try { read(); return false; } catch { return true; }
}
// A workspace navigation attempted by its nested content must stay inside the sandbox.
try { top.location = 'about:blank'; } catch { /* navigation blocked */ }
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
