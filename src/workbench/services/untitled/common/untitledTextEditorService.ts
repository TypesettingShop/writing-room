import { Event } from '../../../../base/common/event.js';
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
  /** Resources of disposed models whose text model is still being created, and so still taken. */
  private readonly releasing = new Set<string>();

  constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {}

  create(options: INewUntitledTextEditorOptions = {}): UntitledTextEditorModel {
    let resource: URI;
    let counter = 1;
    do {
      resource = URI.from({ scheme: Schemas.untitled, path: `Untitled-${counter++}` });
    } while (this.models.has(resource.toString()) || this.releasing.has(resource.toString()));

    const key = resource.toString();
    const model = this.instantiationService.createInstance(UntitledTextEditorModel, resource, options.initialValue ?? '');
    this.models.set(key, model);
    // Disposing the model gives its number back — once a text model still on its way for the
    // resource is gone too, or the next model with that number could not get one.
    Event.once(model.onWillDispose)(() => {
      this.models.delete(key);
      const pending = model.whenCreationSettles();
      if (pending) {
        this.releasing.add(key);
        const release = () => this.releasing.delete(key);
        pending.then(release, release);
      }
    });
    return model;
  }

  get(resource: URI): UntitledTextEditorModel | undefined {
    return this.models.get(resource.toString());
  }
}

registerSingleton(IUntitledTextEditorService, UntitledTextEditorService);
