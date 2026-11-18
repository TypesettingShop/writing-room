import { registerSingleton } from '../../instantiation/common/extensions.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export const ILayoutService = createDecorator<ILayoutService>('layoutService');

export interface ILayoutService extends BrandedService {
  readonly mainContainer: HTMLElement;
  readonly mainContainerDimension: { readonly width: number; readonly height: number };
  readonly mainContainerOffset: { readonly top: number; readonly quickPickTop: number };
}

export class BrowserLayoutService implements ILayoutService {
  declare readonly _serviceBrand: undefined;
  get mainContainer(): HTMLElement { return document.body; }
  get mainContainerDimension(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  get mainContainerOffset(): { top: number; quickPickTop: number } {
    return { top: 0, quickPickTop: 0 };
  }
}

registerSingleton(ILayoutService, BrowserLayoutService);
