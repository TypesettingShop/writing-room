import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { loadMonaco } from '../../../../editor/browser/monaco.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../../editor/browser/monaco.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IMarkerService } from '../../../../platform/markers/common/markers.js';
import type { IMarker } from '../../../../platform/markers/common/markers.js';

/** Where the bridge draws: Monaco's `setModelMarkers`, or a test's record of the calls. */
export interface IModelMarkerSink {
  setModelMarkers(model: ITextModel, owner: string, markers: readonly IMarker[]): void;
}

function toMonacoMarker(monaco: MonacoNamespace, marker: IMarker) {
  const { code } = marker;
  return {
    severity: marker.severity,
    message: marker.message,
    source: marker.source,
    code: typeof code === 'object' ? { value: code.value, target: monaco.Uri.parse(code.target.toString()) } : code,
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
    relatedInformation: marker.relatedInformation?.map(item => ({
      resource: monaco.Uri.parse(item.resource.toString()),
      message: item.message,
      startLineNumber: item.startLineNumber,
      startColumn: item.startColumn,
      endLineNumber: item.endLineNumber,
      endColumn: item.endColumn,
    })),
    tags: marker.tags ? [...marker.tags] : undefined,
  };
}

/**
 * Draws with Monaco. The models the bridge sees exist only once Monaco is loaded, so the load is
 * already done; the calls still queue on it to stay in order.
 */
export class MonacoModelMarkerSink implements IModelMarkerSink {
  private queue: Promise<unknown> = Promise.resolve();

  setModelMarkers(model: ITextModel, owner: string, markers: readonly IMarker[]): void {
    this.queue = this.queue.then(() => loadMonaco()).then(monaco => {
      if (!model.isDisposed()) {
        monaco.editor.setModelMarkers(model as IMonacoTextModel, owner, markers.map(marker => toMonacoMarker(monaco, marker)));
      }
    }).catch(error => console.error('Markers could not be drawn:', error));
  }
}

/**
 * Keeps the squiggles of each text model in step with the marker service. Each owner is drawn on its
 * own, so a change of one owner leaves the others' markers on the model. A model that opens after its
 * resource got markers draws them at once.
 */
export class MarkersModelBridge extends Disposable {
  /** The owners drawn on each live model, by the model's id. */
  private readonly drawn = new Map<string, { readonly model: ITextModel; readonly owners: Set<string> }>();

  constructor(
    private readonly sink: IModelMarkerSink,
    @IMarkerService private readonly markers: IMarkerService,
    @IModelService private readonly models: IModelService,
  ) {
    super();
    this._register(markers.onMarkerChanged(resources => {
      for (const resource of resources) {
        const model = models.getModel(resource);
        if (model) {
          this.draw(model, resource);
        }
      }
    }));
    this._register(models.onModelAdded(model => this.draw(model, resourceOf(model))));
    this._register(models.onModelRemoved(model => this.drawn.delete(model.id)));
    for (const model of models.getModels()) {
      this.draw(model, resourceOf(model));
    }
  }

  private draw(model: ITextModel, resource: URI): void {
    const byOwner = new Map<string, IMarker[]>();
    for (const marker of this.markers.read({ resource })) {
      let list = byOwner.get(marker.owner);
      if (!list) {
        list = [];
        byOwner.set(marker.owner, list);
      }
      list.push(marker);
    }
    let entry = this.drawn.get(model.id);
    if (!entry) {
      entry = { model, owners: new Set() };
      this.drawn.set(model.id, entry);
    }
    for (const owner of entry.owners) {
      if (!byOwner.has(owner)) {
        this.sink.setModelMarkers(model, owner, []);
        entry.owners.delete(owner);
      }
    }
    for (const [owner, list] of byOwner) {
      this.sink.setModelMarkers(model, owner, list);
      entry.owners.add(owner);
    }
  }
}

/**
 * The workbench resource of a model. Monaco prints its URI with its own escaping; parsing and printing
 * again gives the spelling the marker service keys by.
 */
function resourceOf(model: ITextModel): URI {
  return URI.parse(model.uri.toString());
}
