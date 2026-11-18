import { Emitter } from '../../../base/common/event.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITextModel } from '../../common/model.js';
import type { IModelService } from '../../common/services/model.js';

/** A text model without Monaco, for jsdom. */
export class TestTextModel implements ITextModel {
  private readonly changed = new Emitter<void>();
  private disposed = false;

  constructor(readonly uri: URI, private value: string, readonly languageId: string) {}

  getValue(): string { return this.value; }
  getValueLength(): number { return this.value.length; }

  setValue(value: string): void {
    this.value = value;
    this.changed.fire();
  }

  onDidChangeContent(listener: (event: unknown) => void): IDisposable {
    return this.changed.event(listener);
  }

  isDisposed(): boolean { return this.disposed; }

  dispose(): void {
    this.disposed = true;
    this.changed.dispose();
  }
}

export class TestModelService implements IModelService {
  declare readonly _serviceBrand: undefined;
  readonly created: TestTextModel[] = [];
  /** When set, `createModel` waits for it. */
  gate: Promise<void> | undefined;

  async createModel(value: string, languageId: string, resource: URI): Promise<TestTextModel> {
    await this.gate;
    if (this.getModel(resource)) {
      throw new Error(`A model for ${resource} already exists.`);
    }
    const model = new TestTextModel(resource, value, languageId);
    this.created.push(model);
    return model;
  }

  getModel(resource: URI): TestTextModel | null {
    return this.created.find(model => !model.isDisposed() && model.uri.toString() === resource.toString()) ?? null;
  }
}
