import { Emitter } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IMarkerService, MarkerSeverity } from './markers.js';
import type { IMarker, IMarkerData, IMarkerReadOptions, MarkerStatistics } from './markers.js';

interface Entry {
  readonly resource: URI;
  readonly markers: readonly IMarker[];
}

type Counts = { errors: number; warnings: number; infos: number; unknowns: number };

function count(markers: readonly IMarker[], into: Counts, sign: 1 | -1): void {
  for (const { severity } of markers) {
    if (severity === MarkerSeverity.Error) {
      into.errors += sign;
    } else if (severity === MarkerSeverity.Warning) {
      into.warnings += sign;
    } else if (severity === MarkerSeverity.Info) {
      into.infos += sign;
    } else {
      into.unknowns += sign;
    }
  }
}

/** A line or column that Monaco accepts: a whole number of at least 1. */
function position(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function toMarker(owner: string, resource: URI, data: IMarkerData): IMarker | undefined {
  if (typeof data.message !== 'string' || !data.message) {
    return undefined;
  }
  const startLineNumber = position(data.startLineNumber, 1);
  const startColumn = position(data.startColumn, 1);
  let endLineNumber = position(data.endLineNumber, startLineNumber);
  let endColumn = position(data.endColumn, startColumn);
  if (endLineNumber < startLineNumber || (endLineNumber === startLineNumber && endColumn < startColumn)) {
    endLineNumber = startLineNumber;
    endColumn = startColumn;
  }
  return Object.freeze({ ...data, owner, resource, startLineNumber, startColumn, endLineNumber, endColumn });
}

/**
 * Keeps markers by owner and by resource. A resource is its `toString()`: two URIs that print the same
 * are the same resource. Changes made in one synchronous run fire `onMarkerChanged` once, in a
 * microtask, naming each changed resource once (VS Code's `MicrotaskEmitter`).
 */
export class MarkerService implements IMarkerService {
  declare readonly _serviceBrand: undefined;

  private readonly byOwner = new Map<string, Map<string, Entry>>();
  private readonly byResource = new Map<string, Map<string, Entry>>();
  private readonly stats: Counts = { errors: 0, warnings: 0, infos: 0, unknowns: 0 };
  private readonly changed = new Emitter<readonly URI[]>();
  private pending: Map<string, URI> | undefined;
  readonly onMarkerChanged = this.changed.event;

  getStatistics(): MarkerStatistics {
    return { ...this.stats };
  }

  changeOne(owner: string, resource: URI, markers: readonly IMarkerData[]): void {
    const key = resource.toString();
    const converted: IMarker[] = [];
    for (const data of markers) {
      const marker = toMarker(owner, resource, data);
      if (marker) {
        converted.push(marker);
      }
    }
    if (!converted.length) {
      if (this.delete(owner, key)) {
        this.fire(key, resource);
      }
      return;
    }
    // Set over the old entry, so the owner keeps its place among the resource's owners.
    const previous = this.byOwner.get(owner)?.get(key);
    if (previous) {
      count(previous.markers, this.stats, -1);
    }
    const entry: Entry = { resource, markers: Object.freeze(converted) };
    this.entries(this.byOwner, owner).set(key, entry);
    this.entries(this.byResource, key).set(owner, entry);
    count(entry.markers, this.stats, 1);
    this.fire(key, resource);
  }

  changeAll(owner: string, data: readonly { readonly resource: URI; readonly marker: IMarkerData }[]): void {
    const grouped = new Map<string, { resource: URI; markers: IMarkerData[] }>();
    for (const { resource, marker } of data) {
      const key = resource.toString();
      let group = grouped.get(key);
      if (!group) {
        group = { resource, markers: [] };
        grouped.set(key, group);
      }
      group.markers.push(marker);
    }
    for (const [key, { resource }] of this.byOwner.get(owner) ?? []) {
      if (!grouped.has(key)) {
        this.changeOne(owner, resource, []);
      }
    }
    for (const { resource, markers } of grouped.values()) {
      this.changeOne(owner, resource, markers);
    }
  }

  remove(owner: string, resources: readonly URI[]): void {
    for (const resource of resources) {
      this.changeOne(owner, resource, []);
    }
  }

  read(filter: IMarkerReadOptions = {}): IMarker[] {
    const { owner, resource, severities, take } = filter;
    const limit = take !== undefined && take >= 0 ? take : Infinity;
    let entries: Iterable<Entry>;
    if (owner !== undefined && resource) {
      const entry = this.byOwner.get(owner)?.get(resource.toString());
      entries = entry ? [entry] : [];
    } else if (owner !== undefined) {
      entries = this.byOwner.get(owner)?.values() ?? [];
    } else if (resource) {
      entries = this.byResource.get(resource.toString())?.values() ?? [];
    } else {
      entries = [...this.byOwner.values()].flatMap(map => [...map.values()]);
    }
    const result: IMarker[] = [];
    for (const entry of entries) {
      for (const marker of entry.markers) {
        if (result.length >= limit) {
          return result;
        }
        if (severities === undefined || (marker.severity & severities) !== 0) {
          result.push(marker);
        }
      }
    }
    return result;
  }

  dispose(): void {
    this.changed.dispose();
  }

  private entries(map: Map<string, Map<string, Entry>>, key: string): Map<string, Entry> {
    let entries = map.get(key);
    if (!entries) {
      entries = new Map();
      map.set(key, entries);
    }
    return entries;
  }

  private delete(owner: string, key: string): boolean {
    const entry = this.byOwner.get(owner)?.get(key);
    if (!entry) {
      return false;
    }
    count(entry.markers, this.stats, -1);
    for (const [map, first, second] of [[this.byOwner, owner, key], [this.byResource, key, owner]] as const) {
      const entries = map.get(first)!;
      entries.delete(second);
      if (!entries.size) {
        map.delete(first);
      }
    }
    return true;
  }

  private fire(key: string, resource: URI): void {
    if (!this.pending) {
      this.pending = new Map();
      queueMicrotask(() => {
        const resources = [...this.pending!.values()];
        this.pending = undefined;
        this.changed.fire(Object.freeze(resources));
      });
    }
    if (!this.pending.has(key)) {
      this.pending.set(key, resource);
    }
  }
}

registerSingleton(IMarkerService, MarkerService);
