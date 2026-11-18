import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { UntitledTextEditorModel } from './untitledTextEditorModel.js';

export const IUntitledTextEditorService = createDecorator<IUntitledTextEditorService>('untitledTextEditorService');

export interface INewUntitledTextEditorOptions {
  readonly initialValue?: string;
}

export interface IUntitledTextEditorService extends BrandedService {
  /** Creates the model of a new untitled editor, `Untitled-N` with the lowest `N` not in use. */
  create(options?: INewUntitledTextEditorOptions): UntitledTextEditorModel;
  get(resource: URI): UntitledTextEditorModel | undefined;
}

export class UntitledTextEditorService implements IUntitledTextEditorService {
  declare readonly _serviceBrand: undefined;
  private readonly models = new Map<string, UntitledTextEditorModel>();

  constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {}

  create(options: INewUntitledTextEditorOptions = {}): UntitledTextEditorModel {
    let resource: URI;
    let counter = 1;
    do {
      resource = URI.from({ scheme: Schemas.untitled, path: `Untitled-${counter++}` });
    } while (this.models.has(resource.toString()));

    const key = resource.toString();
    const model = this.instantiationService.createInstance(UntitledTextEditorModel, resource, options.initialValue ?? '');
    this.models.set(key, model);
    // Disposing the model gives its number back.
    const listener = model.onWillDispose(() => {
      listener.dispose();
      this.models.delete(key);
    });
    return model;
  }

  get(resource: URI): UntitledTextEditorModel | undefined {
    return this.models.get(resource.toString());
  }
}

registerSingleton(IUntitledTextEditorService, UntitledTextEditorService);
