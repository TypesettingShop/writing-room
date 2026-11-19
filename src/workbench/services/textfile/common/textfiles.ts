import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResolvedTextEditorModel } from '../../../../editor/common/services/resolverService.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';

export const ITextFileService = createDecorator<ITextFileService>('textFileService');

export type SaveReason = 'explicit' | 'auto';

/** Before a text file saves. Listeners may hand in work the save waits for, such as edits to apply first. */
export interface ITextFileWillSaveEvent {
  readonly resource: URI;
  readonly reason: SaveReason;
  /** Only while the event is being delivered; the save waits for every promise handed in. */
  waitUntil(work: Promise<unknown>): void;
}

export interface ITextFileSaveEvent {
  readonly resource: URI;
  readonly reason: SaveReason;
}

export interface ITextFileSaveOptions {
  readonly reason?: SaveReason;
}

/**
 * The text of resources that are saved somewhere: whether it has unsaved changes, saving it, and
 * the events around a save that the document API forwards to extensions. The editor part registers
 * an implementation that knows untitled text only, which has nowhere to be saved; the file editing
 * member registers the real one under the same identifier.
 */
export interface ITextFileService extends BrandedService {
  readonly onWillSave: Event<ITextFileWillSaveEvent>;
  readonly onDidSave: Event<ITextFileSaveEvent>;
  /** A resource's text gained or lost unsaved changes. */
  readonly onDidChangeDirty: Event<URI>;

  isDirty(resource: URI): boolean;
  /** Saves the resource's text; resolves to where it was saved, or `undefined` when it was not. */
  save(resource: URI, options?: ITextFileSaveOptions): Promise<URI | undefined>;
  /** Whether this service holds the text of `resource`, so text model references come here. */
  canHandleResource(resource: URI): boolean;
  /** The resource's text model. This service owns it: a reference never disposes it. */
  resolve(resource: URI): Promise<IResolvedTextEditorModel>;
}

/** The text file service the workbench starts with: untitled text only, which never saves. */
export class UntitledTextFileService extends Disposable implements ITextFileService {
  declare readonly _serviceBrand: undefined;

  private readonly _onWillSave = this._register(new Emitter<ITextFileWillSaveEvent>());
  /** Never fires: nothing saves here. */
  readonly onWillSave = this._onWillSave.event;
  private readonly _onDidSave = this._register(new Emitter<ITextFileSaveEvent>());
  readonly onDidSave = this._onDidSave.event;
  private readonly _onDidChangeDirty = this._register(new Emitter<URI>());
  readonly onDidChangeDirty = this._onDidChangeDirty.event;

  constructor(@IUntitledTextEditorService private readonly untitledService: IUntitledTextEditorService) {
    super();
    this._register(untitledService.onDidChangeDirty(model => this._onDidChangeDirty.fire(model.resource)));
  }

  isDirty(resource: URI): boolean {
    return this.untitledService.get(resource)?.isDirty() ?? false;
  }

  /** Untitled text has no place to go until the file editing member adds Save As. */
  async save(): Promise<URI | undefined> {
    return undefined;
  }

  canHandleResource(resource: URI): boolean {
    return resource.scheme === Schemas.untitled;
  }

  async resolve(resource: URI): Promise<IResolvedTextEditorModel> {
    const untitled = this.untitledService.get(resource);
    if (!untitled) {
      throw new Error(`Unable to resolve resource ${resource}: no such untitled text.`);
    }
    await untitled.resolve();
    const model = untitled.textEditorModel;
    if (!model) {
      throw new Error(`Unable to resolve resource ${resource}: the untitled text was disposed.`);
    }
    // The untitled input owns the model, so the object handed out disposes nothing.
    return { textEditorModel: model, dispose: () => {} };
  }
}
