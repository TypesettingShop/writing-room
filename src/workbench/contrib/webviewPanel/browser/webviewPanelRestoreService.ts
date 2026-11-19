import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IWebviewStateStore } from '../../webview/browser/webviewStateStore.js';
import type { WebviewEditorInput } from './webviewEditorInput.js';

type Serializer = (input: WebviewEditorInput, generation: number) => Promise<void>;

export const IWebviewPanelRestoreService = createDecorator<IWebviewPanelRestoreService>('webviewPanelRestoreService');

export interface IWebviewPanelRestoreService extends BrandedService {
  register(extension: string, viewType: string, restore: Serializer): IDisposable;
  show(input: WebviewEditorInput): void;
}

export class WebviewPanelRestoreService extends Disposable implements IWebviewPanelRestoreService {
  declare readonly _serviceBrand: undefined;
  private readonly serializers = new Map<string, Serializer>();
  private readonly pending = new WeakMap<WebviewEditorInput, number>();

  constructor(@IExtensionService private readonly extensions: IExtensionService, @IWebviewStateStore state: IWebviewStateStore) {
    super();
    const prune = () => {
      if (extensions.extensions) {
        state.removeMissingExtensions(new Set(extensions.extensions.map(extension => extension.identifier.value)));
      }
    };
    if (extensions.onDidChangeExtensions) {
      this._register(extensions.onDidChangeExtensions(prune));
    }
    void extensions.whenInstalledExtensionsRegistered().then(prune);
  }

  register(extension: string, viewType: string, restore: Serializer): IDisposable {
    const key = this.key(extension, viewType);
    if (this.serializers.has(key)) {
      throw new Error('A Webview panel serializer is already registered for ' + viewType);
    }
    this.serializers.set(key, restore);
    return toDisposable(() => {
      if (this.serializers.get(key) === restore) {
        this.serializers.delete(key);
      }
    });
  }

  show(input: WebviewEditorInput): void {
    const generation = input.restoreGeneration;
    if (generation === undefined || this.pending.get(input) === generation || input.isDisposed()) {
      return;
    }
    this.pending.set(input, generation);
    void this.restore(input, generation).finally(() => {
      if (this.pending.get(input) === generation) {
        this.pending.delete(input);
      }
    });
  }

  private async restore(input: WebviewEditorInput, generation: number): Promise<void> {
    const live = () => !input.isDisposed() && input.restoreGeneration === generation;
    try {
      await this.extensions.whenInstalledExtensionsRegistered();
      if (!live()) {
        return;
      }
      const owner = this.extensions.extensions?.find(extension => extension.identifier.value === input.extensionId);
      const event = 'onWebviewPanel:' + input.viewType;
      if (!owner?.manifest.browser || !owner.manifest.activationEvents?.includes(event)) {
        input.completeRestore(generation, 'The extension that provides this Webview is unavailable.');
        return;
      }
      if (!input.webview.isVisible) {
        return;
      }
      await this.extensions.activateByEvent(event);
      if (!live()) {
        return;
      }
      const restore = this.serializers.get(this.key(input.extensionId, input.viewType));
      if (!restore) {
        throw new Error('The extension did not register a serializer for this Webview.');
      }
      await restore(input, generation);
      input.completeRestore(generation);
    } catch {
      input.completeRestore(generation, 'The extension could not restore this Webview.');
    }
  }

  private key(extension: string, viewType: string): string {
    return JSON.stringify([extension, viewType]);
  }
}

registerSingleton(IWebviewPanelRestoreService, WebviewPanelRestoreService);
