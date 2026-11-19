import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../platform/instantiation/common/instantiation.js';
import type { ITextModel } from '../model.js';

/** What a text editor input resolves to. */
export interface ITextEditorModel extends IDisposable {
  /** The text model, once resolved; `null` before that and after disposal. */
  readonly textEditorModel: ITextModel | null;
}

export interface IResolvedTextEditorModel extends ITextEditorModel {
  readonly textEditorModel: ITextModel;
}

export function isTextEditorModel(value: unknown): value is ITextEditorModel {
  return typeof value === 'object' && value !== null && 'textEditorModel' in value;
}

/** A counted hold on a shared object; disposing it lets go of this hold only. */
export interface IReference<T> extends IDisposable {
  readonly object: T;
}

/** Makes the text of the resources of one scheme, such as a read-only virtual document. */
export interface ITextModelContentProvider {
  /**
   * Creates the model for `resource` with the model service, or answers `null` when it has none.
   * The reference service owns what it gets and disposes it after the last reference goes.
   */
  provideTextContent(resource: URI): Promise<ITextModel | null> | ITextModel | null;
}

export const ITextModelService = createDecorator<ITextModelService>('textModelService');

/**
 * Hands out counted references to the text model of a resource, creating it on the first one. A
 * model that belongs to someone else (an untitled editor's, the settings editor's) stays when the
 * last reference goes; one a content provider made is disposed then.
 */
export interface ITextModelService extends BrandedService {
  /** Rejects when no one can make the resource's text. */
  createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>>;
  /** The providers of a scheme are asked latest first, until one gives a model. */
  registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable;
  canHandleResource(resource: URI): boolean;
}
