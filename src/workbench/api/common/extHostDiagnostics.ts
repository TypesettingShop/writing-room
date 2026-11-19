import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { limitMarkers, MAX_MARKERS_PER_RESOURCE } from '../../../platform/markers/common/markers.js';
import { ExtHostDiagnosticsProxy, MainThreadDiagnosticsProxy } from './extHost.protocol.diagnostics.js';
import type {
  ExtHostDiagnosticsShape, MainThreadDiagnosticsShape, MarkerChangeDto, MarkerDataDto,
} from './extHost.protocol.diagnostics.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import {
  Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, DiagnosticTag, fromMarkerData, toMarkerData,
} from './extHostDiagnosticTypes.js';

export { Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, DiagnosticTag } from './extHostDiagnosticTypes.js';

type Entry = [uri: vscode.Uri, diagnostics: vscode.Diagnostic[]];

/** How long changes gather before `onDidChangeDiagnostics` fires (VS Code's `DebounceEmitter` delay). */
export const DIAGNOSTICS_EVENT_DELAY = 50;

function checkUri(value: unknown): vscode.Uri {
  if (!URI.isUri(value)) {
    throw new Error('Illegal argument: uri');
  }
  return value as unknown as vscode.Uri;
}

/** Drops holes in the array, as VS Code's `coalesce` does. */
function present(diagnostics: readonly (vscode.Diagnostic | undefined | null)[]): vscode.Diagnostic[] {
  return diagnostics.filter((diagnostic): diagnostic is vscode.Diagnostic => !!diagnostic);
}

/**
 * One extension's collection. It keeps the diagnostics as the extension gave them; the workbench gets
 * at most `MAX_MARKERS_PER_RESOURCE` markers for a resource, the most severe, and a note on the rest.
 * Resources are keys by `toString()`, so two spellings of one URI are one entry.
 */
export class DiagnosticCollection implements vscode.DiagnosticCollection {
  readonly #data = new Map<string, Entry>();
  #disposed = false;

  constructor(
    private readonly collectionName: string,
    private readonly sync: {
      changeMany(entries: readonly MarkerChangeDto[]): void;
      clear(): void;
      changed(uris: readonly vscode.Uri[]): void;
      disposed(): void;
    },
  ) {}

  get name(): string {
    this.checkDisposed();
    return this.collectionName;
  }

  set(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[] | undefined): void;
  set(entries: ReadonlyArray<[vscode.Uri, readonly vscode.Diagnostic[] | undefined]>): void;
  set(
    first: vscode.Uri | ReadonlyArray<[vscode.Uri, readonly vscode.Diagnostic[] | undefined]> | undefined,
    diagnostics?: readonly vscode.Diagnostic[],
  ): void {
    if (!first) {
      this.clear();
      return;
    }
    this.checkDisposed();
    // What replaces each touched resource; an empty list in the many-entries form removes it.
    const next = new Map<string, Entry>();
    let keepEmpty = false;
    if (!Array.isArray(first)) {
      const uri = checkUri(first);
      if (!diagnostics) {
        this.delete(uri);
        return;
      }
      if (!Array.isArray(diagnostics)) {
        throw new Error('Illegal argument: diagnostics');
      }
      next.set(uri.toString(), [uri, present(diagnostics)]);
      keepEmpty = true;
    } else {
      // Entries for one resource add up, and `[uri, undefined]` empties what came before it.
      for (const entry of first) {
        if (!Array.isArray(entry)) {
          throw new Error('Illegal argument: entries');
        }
        const uri = checkUri(entry[0]);
        const key = uri.toString();
        let value = next.get(key);
        if (!value) {
          value = [uri, []];
          next.set(key, value);
        }
        if (!entry[1]) {
          value[1].length = 0;
        } else if (Array.isArray(entry[1])) {
          value[1].push(...present(entry[1]));
        } else {
          throw new Error('Illegal argument: diagnostics');
        }
      }
    }
    // Converted before anything is kept: a diagnostic that cannot be converted leaves the collection as it was.
    const changes: MarkerChangeDto[] = [];
    for (const [uri, list] of next.values()) {
      const kept = keepEmpty || list.length > 0;
      changes.push([uri as unknown as URI, kept ? limitMarkers(list.map(toMarkerData), MAX_MARKERS_PER_RESOURCE) : undefined]);
    }
    for (const [key, value] of next) {
      if (keepEmpty || value[1].length) {
        this.#data.set(key, value);
      } else {
        this.#data.delete(key);
      }
    }
    this.sync.changed([...next.values()].map(([uri]) => uri));
    this.sync.changeMany(changes);
  }

  delete(uri: vscode.Uri): void {
    this.checkDisposed();
    const key = checkUri(uri).toString();
    const entry = this.#data.get(key);
    if (entry) {
      this.#data.delete(key);
      this.sync.changed([entry[0]]);
      this.sync.changeMany([[entry[0] as unknown as URI, undefined]]);
    }
  }

  clear(): void {
    this.checkDisposed();
    this.clearData();
  }

  forEach(
    callback: (uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[], collection: vscode.DiagnosticCollection) => any,
    thisArg?: any,
  ): void {
    this.checkDisposed();
    for (const [uri, diagnostics] of this) {
      callback.call(thisArg, uri, diagnostics, this);
    }
  }

  *[Symbol.iterator](): IterableIterator<[uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]]> {
    this.checkDisposed();
    for (const [uri] of [...this.#data.values()]) {
      yield [uri, this.get(uri)];
    }
  }

  /** A frozen copy; an empty list for a resource the collection does not have, as in VS Code. */
  get(uri: vscode.Uri): readonly vscode.Diagnostic[] {
    this.checkDisposed();
    const entry = this.#data.get(checkUri(uri).toString());
    return Object.freeze(entry ? entry[1].slice() : []);
  }

  has(uri: vscode.Uri): boolean {
    this.checkDisposed();
    return this.#data.has(checkUri(uri).toString());
  }

  dispose(): void {
    if (!this.#disposed) {
      this.clearData();
      this.#disposed = true;
      this.sync.disposed();
    }
  }

  /** The diagnostics for a resource key, without the frozen copy. */
  peek(key: string): Entry | undefined {
    return this.#data.get(key);
  }

  entries(): IterableIterator<Entry> {
    return this.#data.values();
  }

  private clearData(): void {
    const uris = [...this.#data.values()].map(([uri]) => uri);
    this.#data.clear();
    if (uris.length) {
      this.sync.changed(uris);
    }
    this.sync.clear();
  }

  private checkDisposed(): void {
    if (this.#disposed) {
      throw new Error('illegal state - object is disposed');
    }
  }
}

/**
 * The extension host's diagnostics: the collections of every extension, and a mirror of the markers
 * that other owners in the workbench hold, so `getDiagnostics` and `onDidChangeDiagnostics` see all of
 * them.
 */
export class ExtHostDiagnostics implements ExtHostDiagnosticsShape {
  private readonly collections = new Map<string, Map<string, DiagnosticCollection>>();
  private readonly mirror = new Map<string, Entry>();
  private readonly emitters = new Map<string, Emitter<vscode.DiagnosticChangeEvent>>();
  private readonly pending = new Map<string, vscode.Uri>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nextGeneratedName = 0;

  constructor(private readonly proxy: MainThreadDiagnosticsShape) {}

  createDiagnosticCollection(extension: string, name?: string): vscode.DiagnosticCollection {
    const owned = this.collections.get(extension) ?? new Map<string, DiagnosticCollection>();
    this.collections.set(extension, owned);
    let owner: string;
    if (!name) {
      name = '_generated_diagnostic_collection_name_#' + this.nextGeneratedName++;
      owner = name;
    } else if (!owned.has(name)) {
      owner = name;
    } else {
      console.warn(`DiagnosticCollection with name '${name}' does already exist.`);
      do {
        owner = name + this.nextGeneratedName++;
      } while (owned.has(owner));
    }
    const report = (operation: Promise<void>) => operation.catch(error => {
      console.warn(`[${extension}] Diagnostics of '${owner}' did not reach the workbench:`, error);
    });
    const collection = new DiagnosticCollection(name, {
      changeMany: entries => report(this.proxy.$changeMany(extension, owner, entries)),
      clear: () => report(this.proxy.$clear(extension, owner)),
      changed: uris => this.changed(uris),
      disposed: () => {
        if (owned.get(owner) === collection) {
          owned.delete(owner);
        }
      },
    });
    owned.set(owner, collection);
    return collection;
  }

  getDiagnostics(resource: vscode.Uri): vscode.Diagnostic[];
  getDiagnostics(): [vscode.Uri, vscode.Diagnostic[]][];
  getDiagnostics(resource?: vscode.Uri): vscode.Diagnostic[] | [vscode.Uri, vscode.Diagnostic[]][];
  getDiagnostics(resource?: vscode.Uri): vscode.Diagnostic[] | [vscode.Uri, vscode.Diagnostic[]][] {
    if (resource !== undefined) {
      const key = checkUri(resource).toString();
      return this.sources().flatMap(source => source(key)?.[1] ?? []);
    }
    const result = new Map<string, Entry>();
    for (const entries of [...this.allCollections().map(collection => collection.entries()), this.mirror.values()]) {
      for (const [uri, diagnostics] of entries) {
        const key = uri.toString();
        const entry = result.get(key);
        if (entry) {
          entry[1].push(...diagnostics);
        } else {
          result.set(key, [uri, [...diagnostics]]);
        }
      }
    }
    return [...result.values()];
  }

  onDidChangeDiagnostics(extension: string): vscode.Event<vscode.DiagnosticChangeEvent> {
    let emitter = this.emitters.get(extension);
    if (!emitter) {
      emitter = new Emitter();
      this.emitters.set(extension, emitter);
    }
    return emitter.event;
  }

  async $acceptMarkersChange(data: readonly (readonly [URI, readonly MarkerDataDto[]])[]): Promise<void> {
    const uris: vscode.Uri[] = [];
    for (const [components, markers] of data) {
      const uri = URI.revive(components) as unknown as vscode.Uri;
      const key = uri.toString();
      if (markers.length) {
        this.mirror.set(key, [uri, markers.map(fromMarkerData)]);
      } else if (!this.mirror.delete(key)) {
        continue;
      }
      uris.push(uri);
    }
    this.changed(uris);
  }

  /** Disposes an extension's collections, which clears their markers, and stops its events. */
  release(extension: string): void {
    for (const collection of [...this.collections.get(extension)?.values() ?? []]) {
      collection.dispose();
    }
    this.collections.delete(extension);
    this.emitters.get(extension)?.dispose();
    this.emitters.delete(extension);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    for (const emitter of this.emitters.values()) {
      emitter.dispose();
    }
    this.emitters.clear();
    this.collections.clear();
    this.mirror.clear();
  }

  private allCollections(): DiagnosticCollection[] {
    return [...this.collections.values()].flatMap(owned => [...owned.values()]);
  }

  private sources(): ((key: string) => Entry | undefined)[] {
    return [...this.allCollections().map(collection => (key: string) => collection.peek(key)), (key: string) => this.mirror.get(key)];
  }

  /** Gathers changed resources and fires once for them, each named once. */
  private changed(uris: readonly vscode.Uri[]): void {
    for (const uri of uris) {
      const key = uri.toString();
      if (!this.pending.has(key)) {
        this.pending.set(key, uri);
      }
    }
    if (this.pending.size && this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const event: vscode.DiagnosticChangeEvent = Object.freeze({ uris: Object.freeze([...this.pending.values()]) });
        this.pending.clear();
        for (const emitter of [...this.emitters.values()]) {
          emitter.fire(event);
        }
      }, DIAGNOSTICS_EVENT_DELAY);
    }
  }
}

extHostApiRegistry.register('diagnostics', ({ rpc }) => {
  const proxy = rpc.getProxy(MainThreadDiagnosticsProxy);
  const diagnostics = new ExtHostDiagnostics(proxy);
  rpc.set(ExtHostDiagnosticsProxy, diagnostics);
  // The workbench's earlier changes reached this host before it could take them: ask for the markers there are now.
  // It fails only when the workbench has no diagnostics side, or the host is stopping.
  void proxy.$requestMarkers().catch(() => {});
  return {
    service: diagnostics,
    create: ({ key }) => ({
      types: { Diagnostic, DiagnosticRelatedInformation, DiagnosticSeverity, DiagnosticTag },
      namespaces: {
        languages: {
          createDiagnosticCollection: (name?: string) => diagnostics.createDiagnosticCollection(key, name),
          getDiagnostics: ((resource?: vscode.Uri) => diagnostics.getDiagnostics(resource)) as typeof vscode.languages.getDiagnostics,
          // Looked up on each call: a released extension that is activated again gets events again.
          onDidChangeDiagnostics: (listener, thisArgs?, disposables?) =>
            diagnostics.onDidChangeDiagnostics(key)(listener, thisArgs, disposables),
        } satisfies Pick<typeof vscode.languages, 'createDiagnosticCollection' | 'getDiagnostics' | 'onDidChangeDiagnostics'>,
      },
    }),
    release: key => diagnostics.release(key),
    dispose: () => diagnostics.dispose(),
  };
});
