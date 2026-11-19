import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../../../editor/common/languages/language.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../common/editor.js';
import type { IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import { UntitledTextEditorInput } from './untitledTextEditorInput.js';
import type { UntitledTextEditorModel } from './untitledTextEditorModel.js';
import { IUntitledTextEditorService } from './untitledTextEditorService.js';

export const UNTITLED_TEXT_LIMIT = 1_000_000;

// Pack the UTF-16 code units directly. The stored string stays bounded even for control characters
// that JSON would expand, and lone surrogates round-trip as written.
function encodeText(text: string): string {
  let bytes = '';
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    bytes += String.fromCharCode(unit & 0xff, unit >>> 8);
  }
  return btoa(bytes);
}

function decodeText(encoded: string): string | undefined {
  if (encoded.length > Math.ceil(UNTITLED_TEXT_LIMIT * 2 / 3) * 4) {
    return undefined;
  }
  const bytes = atob(encoded);
  if (bytes.length % 2 !== 0 || bytes.length > UNTITLED_TEXT_LIMIT * 2) {
    return undefined;
  }
  let text = '';
  for (let i = 0; i < bytes.length; i += 2) {
    text += String.fromCharCode(bytes.charCodeAt(i) | (bytes.charCodeAt(i + 1) << 8));
  }
  return text;
}

/**
 * A language id as it may stand in a saved editor: no whitespace or control characters, and not
 * longer than this. Anything else is dropped and the text opens in the language guessed for it.
 */
const MAX_LANGUAGE_ID_LENGTH = 256;
function readLanguageId(value: string): string | undefined {
  return value.length <= MAX_LANGUAGE_ID_LENGTH && /^[^\s\p{Cc}]+$/u.test(value) ? value : undefined;
}

/**
 * `name`, or `name\ntext` for the first tab of an input, or `name\ntext\nlanguage` when its language
 * is not plain text. v0.1.0 saved the first two only; they still read, in the language guessed for
 * the text.
 */
export class UntitledTextEditorInputSerializer implements IEditorSerializer {
  private readonly restoredInputs = new WeakMap<UntitledTextEditorModel, UntitledTextEditorInput>();

  canSerialize(editor: EditorInput): boolean {
    return editor instanceof UntitledTextEditorInput && editor.model.getValueLength() <= UNTITLED_TEXT_LIMIT;
  }

  serialize(editor: EditorInput): string | undefined {
    if (editor instanceof UntitledTextEditorInput && this.canSerialize(editor)) {
      // Plain text keeps the v0.1.0 form: without a language, restoring guesses one again.
      const languageId = editor.model.getLanguageId();
      const language = languageId === PLAINTEXT_LANGUAGE_ID ? '' : '\n' + languageId;
      return editor.getName() + '\n' + encodeText(editor.model.getValue()) + language;
    }
    return undefined;
  }

  deserialize(instantiationService: IInstantiationService, value: string): EditorInput | undefined {
    // The first tab in grid order holds the text. Other tabs of the same input only hold its name.
    const separator = value.indexOf('\n');
    const name = separator < 0 ? value : value.slice(0, separator);
    if (!/^Untitled-[1-9][0-9]*$/.test(name) || !Number.isSafeInteger(Number(name.slice('Untitled-'.length)))) {
      return undefined;
    }
    const resource = URI.from({ scheme: Schemas.untitled, path: name });
    const service = instantiationService.invokeFunction(accessor => accessor.get(IUntitledTextEditorService));
    if (separator < 0) {
      const model = service.get(resource);
      return model && this.restoredInputs.get(model);
    }
    // Base64 has no line breaks, so a second one starts the language.
    const rest = value.slice(separator + 1);
    const languageSeparator = rest.indexOf('\n');
    const text = decodeText(languageSeparator < 0 ? rest : rest.slice(0, languageSeparator));
    if (text === undefined) {
      return undefined;
    }
    const languageId = languageSeparator < 0 ? undefined : readLanguageId(rest.slice(languageSeparator + 1));
    const model = service.restore(resource, text, languageId);
    let input = this.restoredInputs.get(model);
    if (!input) {
      input = instantiationService.createInstance(UntitledTextEditorInput, model);
      this.restoredInputs.set(model, input);
    }
    return input;
  }
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)!
  .registerEditorSerializer(UntitledTextEditorInput.ID, UntitledTextEditorInputSerializer);
