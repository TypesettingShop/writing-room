import type * as vscode from 'vscode';
import { EventEmitter } from './extHostTypes.js';
import type { ExtensionStateScope, ExtHostStorageShape, MainThreadStorageShape } from './extHost.protocol.runtime.js';
import { ExtHostMemento } from './extHostMemento.js';

class ExtensionStorage {
  readonly global: ExtHostMemento;
  readonly workspace: ExtHostMemento;
  readonly secrets: vscode.SecretStorage;
  readonly changed = new EventEmitter<vscode.SecretStorageChangeEvent>();

  constructor(key: string, checkLive: () => void, private readonly proxy: MainThreadStorageShape) {
    this.global = new ExtHostMemento(checkLive, (name, json) => proxy.$update(key, 'global', name, json));
    this.workspace = new ExtHostMemento(checkLive, (name, json) => proxy.$update(key, 'workspace', name, json));
    this.secrets = Object.freeze({
      keys: async () => { checkLive(); return proxy.$getSecretKeys(key); },
      get: async (name: string) => { checkLive(); return proxy.$getSecret(key, name); },
      store: async (name: string, value: string) => { checkLive(); await proxy.$setSecret(key, name, value); },
      delete: async (name: string) => { checkLive(); await proxy.$setSecret(key, name, undefined); },
      onDidChange: this.changed.event,
    });
  }

  async initialize(key: string): Promise<void> {
    const { global, workspace } = await this.proxy.$initialize(key);
    this.global.accept(global);
    this.workspace.accept(workspace);
  }
}

export class ExtHostStorage implements ExtHostStorageShape {
  private readonly states = new Map<string, ExtensionStorage>();

  constructor(private readonly proxy: MainThreadStorageShape) {}

  create(key: string, checkLive: () => void): ExtensionStorage {
    const state = new ExtensionStorage(key, checkLive, this.proxy);
    this.states.set(key, state);
    return state;
  }

  $acceptState(key: string, scope: ExtensionStateScope, json: string): void {
    this.states.get(key)?.[scope].accept(json);
  }

  $acceptSecretChange(key: string, name: string): void {
    this.states.get(key)?.changed.fire({ key: name });
  }

  release(key: string): void {
    this.states.get(key)?.changed.dispose();
    this.states.delete(key);
  }
}
