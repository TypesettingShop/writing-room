import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { ITextModel } from '../model.js';

/** What a text editor input resolves to. */
export interface ITextEditorModel extends IDisposable {
  /** The text model, once resolved; `null` before that and after disposal. */
  readonly textEditorModel: ITextModel | null;
}

export function isTextEditorModel(value: unknown): value is ITextEditorModel {
  return typeof value === 'object' && value !== null && 'textEditorModel' in value;
}
