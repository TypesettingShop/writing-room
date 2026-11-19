import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { WebviewPanelOptions } from '../../../api/common/extHost.protocol.webview.js';
import type { CustomEditorInput } from './customEditorInput.js';

export const ICustomEditorService = createDecorator<ICustomEditorService>('customEditorService');

/** What an extension host registered for a `viewType` with `window.registerCustomEditorProvider`. */
export interface ICustomEditorProvider {
  /** The identifier of the extension that registered it, as the extension service knows it. */
  readonly extensionId: string;
  /** `text`: a `CustomTextEditorProvider`; `custom`: a provider with its own documents. */
  readonly kind: 'text' | 'custom';
  /** A `CustomEditorProvider` (it saves); a `CustomReadonlyEditorProvider` is not. */
  readonly editable: boolean;
  readonly options: WebviewPanelOptions;
  readonly supportsMultipleEditorsPerDocument: boolean;
  /**
   * Hands `input` to the extension. A text editor's model is already held; a custom document is
   * opened here, once for all its editors, and attached to the input. It settles once the extension
   * has resolved the editor, and rejects when it threw; a result after `token` is cancelled is
   * dropped by the caller.
   */
  resolve(input: CustomEditorInput, token: CancellationToken): Promise<void>;
}

/** Custom editors: the contributed ones, the providers behind them, and the inputs that show them. */
export interface ICustomEditorService extends BrandedService {
  /** Registers the provider of `viewType`; another one for the same type is refused. */
  registerProvider(viewType: string, provider: ICustomEditorProvider): IDisposable;
  getProvider(viewType: string): ICustomEditorProvider | undefined;
  /**
   * Resolves `input` with its provider, unless it is resolving or resolved: wakes the extension with
   * `onCustomEditor:<viewType>`, holds the model and asks the provider. A `viewType` that is no longer
   * contributed, or that nobody provides after activation, opens in the text editor instead.
   */
  resolve(input: CustomEditorInput): void;
}
