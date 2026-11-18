import { DisposableStore } from '../../src/base/common/lifecycle.js';
import { StorageScope, StorageTarget } from '../../src/platform/storage/common/storage.js';
import { BrowserStorageService } from '../../src/workbench/services/storage/browser/storageService.js';

const storage = new BrowserStorageService();
const subscriptions = new DisposableStore();
const scope = StorageScope.PROFILE;
const key = document.querySelector<HTMLInputElement>('#key')!;
const value = document.querySelector<HTMLInputElement>('#value')!;
const result = document.querySelector<HTMLOutputElement>('#result')!;
const changes: string[] = [];

function render(): void {
  result.value = JSON.stringify({
    state: storage.get('state', scope, ''),
    other: storage.get('other', scope, ''),
    changes,
  });
}

storage.onDidChangeValue(scope, undefined, subscriptions)(event => {
  changes.push((event.external ? 'external:' : 'local:') + event.key);
  render();
});
document.querySelector('#store')!.addEventListener('click', () => {
  storage.store(key.value, value.value, scope, StorageTarget.USER);
});
document.querySelector('#remove')!.addEventListener('click', () => {
  storage.remove(key.value, scope);
});
render();
