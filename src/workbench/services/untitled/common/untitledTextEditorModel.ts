import { Emitter } from '../../../../base/common/event.js';
import type { Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import type { ITextEditorModel } from '../../../../editor/common/services/resolverService.js';

export const PLAINTEXT_LANGUAGE_ID = 'plaintext';

/**
 * The text of one untitled editor. It owns the text model; the model outlives every pane that shows
 * it and goes with this object.
 */
export class UntitledTextEditorModel extends Disposable implements ITextEditorModel {
  private readonly _onDidChangeDirty = this._register(new Emitter<void>());
  readonly onDidChangeDirty: Event<void> = this._onDidChangeDirty.event;

  private readonly _onWillDispose = this._register(new Emitter<void>());
  readonly onWillDispose: Event<void> = this._onWillDispose.event;

  private model: ITextModel | null = null;
  private readonly modelListener = this._register(new MutableDisposable());
  private resolving: Promise<void> | undefined;
  private dirty: boolean;
  private disposed = false;

  constructor(
    readonly resource: URI,
    private readonly initialValue: string,
    @IModelService private readonly modelService: IModelService,
  ) {
    super();
    this.dirty = initialValue.length > 0;
  }

  /** `Untitled-N`. VS Code names an untitled editor after its first line instead. */
  get name(): string {
    return basename(this.resource);
  }

  get textEditorModel(): ITextModel | null {
    return this.model;
  }

  /** Untitled text is dirty while it is not empty. */
  isDirty(): boolean {
    return this.dirty;
  }

  isResolved(): boolean {
    return this.model !== null;
  }

  resolve(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error(`${this.resource} is disposed.`));
    }
    this.resolving ??= this.doResolve().catch(error => {
      // A failed load is a network error; the next resolve tries again.
      this.resolving = undefined;
      throw error;
    });
    return this.resolving;
  }

  private async doResolve(): Promise<void> {
    const model = await this.modelService.createModel(this.initialValue, PLAINTEXT_LANGUAGE_ID, this.resource);
    if (this.disposed) {
      model.dispose();
      return;
    }
    this.model = model;
    this.modelListener.value = model.onDidChangeContent(() => this.setDirty(model.getValueLength() > 0));
    this.setDirty(model.getValueLength() > 0);
  }

  private setDirty(dirty: boolean): void {
    if (this.dirty !== dirty) {
      this.dirty = dirty;
      this._onDidChangeDirty.fire();
    }
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  override dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this._onWillDispose.fire();
    const model = this.model;
    this.model = null;
    super.dispose();
    model?.dispose();
  }
}
