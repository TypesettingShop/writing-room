import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { WebviewViewPane } from './webviewViewPane.js';
import type { ResolveWebviewView } from './webviewViewPane.js';

export const IWebviewViewService = createDecorator<IWebviewViewService>('webviewViewService');

export interface IWebviewViewService extends BrandedService {
  mount(parent: HTMLElement, id: string, extension: string): WebviewViewPane;
  register(id: string, extension: string, resolve: ResolveWebviewView): IDisposable;
}

interface ViewProvider {
  readonly extension: string;
  readonly resolve: ResolveWebviewView;
}

export class WebviewViewService extends Disposable implements IWebviewViewService {
  declare readonly _serviceBrand: undefined;
  private readonly panes = new Map<string, WebviewViewPane>();
  private readonly providers = new Map<string, ViewProvider>();

  constructor(@IExtensionService private readonly extensions: IExtensionService) {
    super();
  }

  mount(parent: HTMLElement, id: string, extension: string): WebviewViewPane {
    this.panes.get(id)?.dispose();
    const pane = new WebviewViewPane(parent, id, extension, () => this.extensions.activateByEvent('onView:' + id));
    this.panes.set(id, pane);
    pane.onDidDispose(() => {
      if (this.panes.get(id) === pane) {
        this.panes.delete(id);
      }
    });
    const provider = this.providers.get(id);
    if (provider?.extension === extension) {
      pane.setProvider(provider.resolve);
    }
    return pane;
  }

  register(id: string, extension: string, resolve: ResolveWebviewView): IDisposable {
    if (this.providers.has(id)) {
      throw new Error('A Webview view provider is already registered for ' + id);
    }
    const provider = { extension, resolve };
    this.providers.set(id, provider);
    const pane = this.panes.get(id);
    if (pane?.extensionId === extension) {
      pane.setProvider(resolve);
    }
    return toDisposable(() => {
      if (this.providers.get(id) === provider) {
        this.providers.delete(id);
        const current = this.panes.get(id);
        if (current?.extensionId === extension) {
          current.setProvider(undefined);
        }
      }
    });
  }

  override dispose(): void {
    for (const pane of this.panes.values()) {
      pane.dispose();
    }
    this.providers.clear();
    super.dispose();
  }
}

registerSingleton(IWebviewViewService, WebviewViewService);
