import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import type { BrandedService } from '../../instantiation/common/instantiation.js';

export const IMarkerService = createDecorator<IMarkerService>('markerService');

/** The values are VS Code's and Monaco's: a higher number is more severe. */
export enum MarkerSeverity {
  Hint = 1,
  Info = 2,
  Warning = 4,
  Error = 8,
}

export namespace MarkerSeverity {
  /** Sorts the more severe first. */
  export function compare(a: MarkerSeverity, b: MarkerSeverity): number {
    return b - a;
  }
}

export enum MarkerTag {
  Unnecessary = 1,
  Deprecated = 2,
}

/** A place elsewhere that explains a marker. Lines and columns are 1-based, as in Monaco. */
export interface IRelatedInformation {
  readonly resource: URI;
  readonly message: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

/** A code with a link: `target` is a web address or a workspace file. */
export interface IMarkerCodeLink {
  readonly value: string;
  readonly target: URI;
}

/** One problem in a resource. Lines and columns are 1-based and the end column is exclusive, as in Monaco. */
export interface IMarkerData {
  readonly code?: string | IMarkerCodeLink;
  readonly severity: MarkerSeverity;
  readonly message: string;
  readonly source?: string;
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
  readonly relatedInformation?: readonly IRelatedInformation[];
  readonly tags?: readonly MarkerTag[];
}

export interface IMarker extends IMarkerData {
  readonly owner: string;
  readonly resource: URI;
}

export interface IMarkerReadOptions {
  readonly owner?: string;
  readonly resource?: URI;
  /** A bit mask of `MarkerSeverity` values. */
  readonly severities?: number;
  /** At most this many markers. */
  readonly take?: number;
}

export interface MarkerStatistics {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly unknowns: number;
}

/** How many markers one owner keeps for one resource (`ExtHostDiagnostics._maxDiagnosticsPerFile`). */
export const MAX_MARKERS_PER_RESOURCE = 1000;

/**
 * The markers of every owner, by owner and resource. An owner replaces its own markers and never
 * touches another owner's. Changes made in one synchronous run fire one event that names each changed
 * resource once.
 */
export interface IMarkerService extends BrandedService {
  /** Fires after the markers of these resources changed. */
  readonly onMarkerChanged: Event<readonly URI[]>;
  /** The counts over every resource and owner. */
  getStatistics(): MarkerStatistics;
  /** Replaces what `owner` has for `resource`. An empty list removes it. */
  changeOne(owner: string, resource: URI, markers: readonly IMarkerData[]): void;
  /** Replaces everything `owner` has. An empty list removes all of it. */
  changeAll(owner: string, data: readonly { readonly resource: URI; readonly marker: IMarkerData }[]): void;
  remove(owner: string, resources: readonly URI[]): void;
  /** Markers by owner, then resource, unsorted: within one owner's resource, in the order they were given. */
  read(filter?: IMarkerReadOptions): IMarker[];
}

/**
 * Keeps the `max` most severe markers, in their order, and adds an information marker that says how
 * many were left out, at the last kept marker's place. As VS Code's extension host does for one
 * resource of a diagnostic collection.
 */
export function limitMarkers<T extends IMarkerData>(markers: readonly T[], max = MAX_MARKERS_PER_RESOURCE): (T | IMarkerData)[] {
  if (markers.length <= max) {
    return [...markers];
  }
  const kept: T[] = [];
  for (const severity of [MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint]) {
    for (const marker of markers) {
      if (kept.length === max) {
        break;
      }
      if (marker.severity === severity) {
        kept.push(marker);
      }
    }
  }
  return [...kept, omittedMarkersNote(markers.length - kept.length, kept.at(-1) ?? markers[0])];
}

/** The information marker that says how many markers were left out, at the place of `at`. */
export function omittedMarkersNote(count: number, at: IMarkerData): IMarkerData {
  return {
    severity: MarkerSeverity.Info,
    message: `Not showing ${count} further errors and warnings.`,
    startLineNumber: at.startLineNumber,
    startColumn: at.startColumn,
    endLineNumber: at.endLineNumber,
    endColumn: at.endColumn,
  };
}
