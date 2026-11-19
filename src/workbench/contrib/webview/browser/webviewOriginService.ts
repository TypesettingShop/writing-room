import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { product } from '../../../../platform/product/common/product.js';
import { getWebviewForwardingPorts, parseWebviewPortHint, resolveWebviewOrigin } from '../common/webviewOrigin.js';
import type { WebviewForwardingPorts, WebviewOrigin } from '../common/webviewOrigin.js';

export const IWebviewOriginService = createDecorator<IWebviewOriginService>('webviewOriginService');

export interface IWebviewOriginService extends BrandedService {
  /** Lets the extension host produce synchronous resource URLs without waiting on the network. */
  getForwardingHint(): WebviewForwardingPorts | undefined;
  /** The authority for choosing an iframe destination. */
  resolve(id: string): Promise<WebviewOrigin>;
}

export class WebviewOriginService implements IWebviewOriginService {
  declare readonly _serviceBrand: undefined;

  getForwardingHint(): WebviewForwardingPorts | undefined {
    const value = document.querySelector<HTMLMetaElement>('meta[name="writing-room-webview-forwarding"]')?.content;
    return value ? parseWebviewPortHint(value) : undefined;
  }

  async resolve(id: string): Promise<WebviewOrigin> {
    const page = new URL(location.href);
    const template = product.webviewContentExternalBaseUrlTemplate;
    const ports = await getWebviewForwardingPorts(page, template);
    return resolveWebviewOrigin(page, template, id, ports);
  }
}

registerSingleton(IWebviewOriginService, WebviewOriginService);
