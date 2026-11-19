import { IFileService } from '../../../../platform/files/common/files.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { WebviewElement } from './webviewElement.js';
import type { WebviewOrigin } from './webviewOrigin.js';

export const IWebviewService = createDecorator<IWebviewService>('webviewService');

export interface IWebviewService extends BrandedService {
  createElement(document: Document, origin: WebviewOrigin): WebviewElement;
}

export class WebviewService implements IWebviewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFileService private readonly files: IFileService,
    @IOpenerService private readonly opener: IOpenerService,
    @IThemeService private readonly theme: IThemeService,
  ) {}

  createElement(document: Document, origin: WebviewOrigin): WebviewElement {
    return new WebviewElement(document, origin, this.files, this.opener, this.theme);
  }
}

registerSingleton(IWebviewService, WebviewService);
