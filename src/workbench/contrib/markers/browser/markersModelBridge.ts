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
      // Monaco keeps markers by resource, past its model: clearing the resource of a gone model is still due.
      if (!markers.length || !model.isDisposed()) {
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
  /** What each owner last drew on each live model, by the model's id. */
  private readonly drawn = new Map<string, Map<string, readonly IMarker[]>>();

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
    this._register(models.onModelRemoved(model => {
      // Monaco's marker service outlives the model, and a model made again for the resource would show
      // what was drawn here; the marker service still has the markers to draw then.
      for (const owner of this.drawn.get(model.id)?.keys() ?? []) {
        this.sink.setModelMarkers(model, owner, []);
      }
      this.drawn.delete(model.id);
    }));
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
    let drawn = this.drawn.get(model.id);
    if (!drawn) {
      drawn = new Map();
      this.drawn.set(model.id, drawn);
    }
    for (const owner of drawn.keys()) {
      if (!byOwner.has(owner)) {
        this.sink.setModelMarkers(model, owner, []);
        drawn.delete(owner);
      }
    }
    for (const [owner, list] of byOwner) {
      // The service keeps an owner's marker objects until that owner changes them: the same ones need no drawing.
      if (!sameMarkers(drawn.get(owner), list)) {
        this.sink.setModelMarkers(model, owner, list);
        drawn.set(owner, list);
      }
    }
  }
}

function sameMarkers(previous: readonly IMarker[] | undefined, next: readonly IMarker[]): boolean {
  return previous?.length === next.length && previous.every((marker, index) => marker === next[index]);
}

/**
 * The workbench resource of a model. Monaco prints its URI with its own escaping; parsing and printing
 * again gives the spelling the marker service keys by.
 */
function resourceOf(model: ITextModel): URI {
  return URI.parse(model.uri.toString());
}
