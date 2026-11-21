import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { WebviewContentOptions, WebviewIcon, WebviewPanelOptions } from '../../../api/common/extHost.protocol.webview.js';
import type { IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { WebviewOverlay } from '../../webview/browser/webviewOverlay.js';
import { toWebviewThemeIcon, WebviewEditorInput } from './webviewEditorInput.js';

const idFormat = /^[\da-f-]{36}$/;
const extensionFormat = /^[\w-]+\.[\w-]+$/;

function recoverResource(value: unknown): URI | undefined {
  if (!isRecord(value) || typeof value.scheme !== 'string' || typeof value.authority !== 'string'
    || typeof value.path !== 'string' || typeof value.query !== 'string' || typeof value.fragment !== 'string'
    || value.hasEncodedPathSeparator === true) {
    return undefined;
  }
  try {
    return URI.from({
      scheme: value.scheme, authority: value.authority, path: value.path,
      query: value.query, fragment: value.fragment,
    }, true);
  } catch {
    return undefined;
  }
}

function recoverIcon(value: unknown): WebviewIcon | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const themeIcon = toWebviewThemeIcon(value);
  if (themeIcon) {
    return themeIcon;
  }
  const light = recoverResource(value.light);
  const dark = recoverResource(value.dark);
  return recoverResource(value) ?? (light && dark ? { light, dark } : undefined);
}

export class WebviewEditorInputSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof WebviewEditorInput && editor.persistent;
  }

  serialize(editor: WebviewEditorInput): string {
    return JSON.stringify({
      version: 1, id: editor.id, extension: editor.extensionId, viewType: editor.viewType,
      title: editor.getName(), options: editor.options, contentOptions: editor.contentOptions, icon: editor.persistedIconPath,
    });
  }

  deserialize(instantiation: IInstantiationService, serialized: string): WebviewEditorInput | undefined {
    try {
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || value.version !== 1 || typeof value.id !== 'string' || !idFormat.test(value.id)
        || typeof value.extension !== 'string' || !extensionFormat.test(value.extension)
        || typeof value.title !== 'string' || typeof value.viewType !== 'string' || !value.viewType
        || !isRecord(value.options) || !isRecord(value.contentOptions)) {
        return undefined;
      }
      const options: WebviewPanelOptions = {
        retainContextWhenHidden: value.options.retainContextWhenHidden === true,
        enableFindWidget: value.options.enableFindWidget === true,
      };
      const contentOptions: WebviewContentOptions = {
        enableScripts: value.contentOptions.enableScripts === true,
        enableForms: typeof value.contentOptions.enableForms === 'boolean' ? value.contentOptions.enableForms : undefined,
        localResourceRoots: Array.isArray(value.contentOptions.localResourceRoots)
          ? value.contentOptions.localResourceRoots.map(recoverResource).filter(resource => resource !== undefined) : undefined,
      };
      const webview = instantiation.createInstance(WebviewOverlay, value.viewType, undefined, options.retainContextWhenHidden === true);
      const input = instantiation.createInstance(WebviewEditorInput,
        value.id, value.extension, value.viewType, value.title, options, webview, true);
      input.contentOptions = contentOptions;
      input.setStoredIconPath(recoverIcon(value.icon));
      input.markForRestore();
      return input;
    } catch {
      return undefined;
    }
  }
}
