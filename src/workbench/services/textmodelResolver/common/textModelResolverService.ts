import { Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import type { URI } from '../../../../base/common/uri.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type {
  IReference, IResolvedTextEditorModel, ITextModelContentProvider,
} from '../../../../editor/common/services/resolverService.js';
import { registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUntitledTextEditorService } from '../../untitled/common/untitledTextEditorService.js';

interface IResolved {
  readonly object: IResolvedTextEditorModel;
  /** Whether this service made the model and so disposes it after the last reference. */
  readonly owned: boolean;
}

interface IEntry {
  count: number;
  readonly resolved: Promise<IResolved>;
}

/** A model someone else owns, lent out under a reference. */
function borrowed(model: ITextModel): IResolvedTextEditorModel {
  return { textEditorModel: model, dispose: () => {} };
}

/**
 * Counts the references to each resource's text model. The first reference creates or finds the
 * model; the last one lets go of it, which disposes it only when a content provider made it here.
 */
export class TextModelResolverService implements ITextModelService {
  declare readonly _serviceBrand: undefined;

  private readonly entries = new Map<string, IEntry>();
  private readonly providers = new Map<string, ITextModelContentProvider[]>();

  constructor(
    @IModelService private readonly modelService: IModelService,
    @IUntitledTextEditorService private readonly untitledService: IUntitledTextEditorService,
  ) {}

  createModelReference(resource: URI): Promise<IReference<IResolvedTextEditorModel>> {
    const key = resource.toString();
    let entry = this.entries.get(key);
    if (entry) {
      entry.count++;
    } else {
      const created: IEntry = { count: 1, resolved: this.resolve(resource) };
      entry = created;
      this.entries.set(key, created);
      created.resolved.then(({ object }) => {
        // A model disposed from elsewhere (its untitled editor closed, say) is no longer the
        // resource's: the next reference starts over.
        Event.once(Event.filter(this.modelService.onModelRemoved, model => model === object.textEditorModel))(() => {
          if (this.entries.get(key) === created) {
            this.entries.delete(key);
          }
        });
      }, () => {
        // A failed resolve is not kept: the next reference tries again.
        if (this.entries.get(key) === created) {
          this.entries.delete(key);
        }
      });
    }
    const held = entry;
    return held.resolved.then(({ object }) => {
      let released = false;
      return {
        object,
        dispose: () => {
          if (!released) {
            released = true;
            this.release(key, held);
          }
        },
      };
    }, error => {
      held.count--;
      throw error;
    });
  }

  private release(key: string, entry: IEntry): void {
    if (--entry.count > 0) {
      return;
    }
    // A reference taken before this settles keeps the model.
    void entry.resolved.then(({ object, owned }) => {
      if (entry.count === 0 && this.entries.get(key) === entry) {
        this.entries.delete(key);
        if (owned) {
          object.dispose();
        }
      }
    }, () => {});
  }

  private async resolve(resource: URI): Promise<IResolved> {
    // Untitled text belongs to its input; a reference never disposes it.
    if (resource.scheme === Schemas.untitled) {
      const untitled = this.untitledService.get(resource);
      if (!untitled) {
        throw new Error(`Unable to resolve resource ${resource}: no such untitled text.`);
      }
      await untitled.resolve();
      const model = untitled.textEditorModel;
      if (!model) {
        throw new Error(`Unable to resolve resource ${resource}: the untitled text was disposed.`);
      }
      return { object: borrowed(model), owned: false };
    }

    // A model that already exists belongs to whoever created it (the settings editor, say).
    const existing = this.modelService.getModel(resource);
    if (existing) {
      return { object: borrowed(existing), owned: false };
    }

    for (const provider of [...this.providers.get(resource.scheme) ?? []]) {
      const model = await provider.provideTextContent(resource);
      if (model) {
        return { object: { textEditorModel: model, dispose: () => model.dispose() }, owned: true };
      }
    }
    throw new Error(`Unable to resolve resource ${resource}: no text model content provider for '${resource.scheme}'.`);
  }

  registerTextModelContentProvider(scheme: string, provider: ITextModelContentProvider): IDisposable {
    const providers = this.providers.get(scheme) ?? [];
    this.providers.set(scheme, providers);
    providers.unshift(provider);
    return toDisposable(() => {
      const index = providers.indexOf(provider);
      if (index !== -1) {
        providers.splice(index, 1);
        if (providers.length === 0 && this.providers.get(scheme) === providers) {
          this.providers.delete(scheme);
        }
      }
    });
  }

  canHandleResource(resource: URI): boolean {
    return resource.scheme === Schemas.untitled || this.providers.has(resource.scheme)
      || this.modelService.getModel(resource) !== null;
  }
}

registerSingleton(ITextModelService, TextModelResolverService);
