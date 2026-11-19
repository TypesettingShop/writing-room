import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { isTextFileScheme } from '../../../services/textfile/common/textfiles.js';
import { CustomEditorInput } from './customEditorInput.js';

const extensionFormat = /^[\w-]+\.[\w-]+$/;

/**
 * Writes a custom editor as its resource, `viewType`, extension, Webview options and kind. The tab comes
 * back empty and resolves when it is shown, waking the extension with `onCustomEditor:<viewType>`.
 * Untitled text is not written: its text lives with the untitled editor.
 */
export class CustomEditorInputSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof CustomEditorInput && editor.resource.scheme !== Schemas.untitled;
  }

  serialize(editor: EditorInput): string | undefined {
    if (!(editor instanceof CustomEditorInput) || !this.canSerialize(editor)) {
      return undefined;
    }
    return JSON.stringify({
      version: 1, resource: editor.resource.toString(), viewType: editor.viewType, extension: editor.extensionId,
      options: { retainContextWhenHidden: editor.options.retainContextWhenHidden === true, enableFindWidget: editor.options.enableFindWidget === true },
      multiple: editor.supportsMultipleEditorsPerDocument, kind: editor.kind,
    });
  }

  deserialize(instantiation: IInstantiationService, serialized: string): CustomEditorInput | undefined {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      return undefined;
    }
    if (!isRecord(value) || value.version !== 1 || typeof value.resource !== 'string' || typeof value.viewType !== 'string'
      || !value.viewType || typeof value.extension !== 'string' || !extensionFormat.test(value.extension)
      || !isRecord(value.options) || typeof value.multiple !== 'boolean' || (value.kind !== 'text' && value.kind !== 'custom')) {
      return undefined;
    }
    let resource: URI;
    try {
      resource = URI.parse(value.resource, true);
    } catch {
      return undefined;
    }
    // A saved state may name anything; only what opens as a text file comes back.
    if (!isTextFileScheme(resource.scheme)) {
      return undefined;
    }
    return instantiation.createInstance(CustomEditorInput, resource, value.viewType, value.extension, {
      retainContextWhenHidden: value.options.retainContextWhenHidden === true,
      enableFindWidget: value.options.enableFindWidget === true,
    }, value.multiple, value.kind);
  }
}
