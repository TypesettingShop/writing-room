import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITextEditorSelection } from '../../editor/common/editor.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export const IOpenerService = createDecorator<IOpenerService>('openerService');

export interface OpenOptions {
  /** Open an editor beside the active group. */
  readonly openToSide?: boolean;
  /** Keep the keyboard focus where it is. */
  readonly preserveFocus?: boolean;
  /** Select this range in the text editor that opens. */
  readonly selection?: ITextEditorSelection;
  /**
   * The `command:` links the caller trusts: `true` for every command, or the ids it allows. Without
   * it a `command:` link is refused, as one from untrusted content must be.
   */
  readonly allowCommands?: boolean | readonly string[];
}

/** Opens what it understands and answers `true`; `false` passes the target on to the next opener. */
export interface IOpener {
  open(resource: URI, options?: OpenOptions): Promise<boolean>;
}

/**
 * The one way to follow a link: a webview's, `env.openExternal`, a document link, a welcome text's
 * or the Extensions view's. Web addresses open in a new tab once the user has seen the whole address
 * and agreed; `command:` links run only when the caller allows that command; workspace resources
 * open in an editor through the openers the workbench registers; anything else is refused.
 */
export interface IOpenerService extends BrandedService {
  /** Registers an opener that is asked before the ones registered earlier. */
  registerOpener(opener: IOpener): IDisposable;
  /** Resolves to whether the target was opened. */
  open(target: URI | string, options?: OpenOptions): Promise<boolean>;
}

/** The schemes that open in a new browser tab after the user agrees. */
export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto']);

/** Schemes no opener may ever follow: they run code or carry content of their own. */
export const REFUSED_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data', 'blob', 'file', 'about']);
