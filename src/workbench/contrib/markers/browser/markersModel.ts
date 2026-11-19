import { basename, dirname } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import type { IMarker } from '../../../../platform/markers/common/markers.js';

/** The most marker rows built into the DOM at once. */
export const MAX_RENDERED_ROWS = 2000;

export interface IMarkersGroup {
  readonly resource: URI;
  readonly key: string;
  /** The file name. */
  readonly label: string;
  /** The folder, empty for a resource without one. */
  readonly description: string;
  /** All of the group's markers in this resource, shown or not. */
  readonly total: number;
  /** The ones that fit under the limit, in display order. */
  readonly markers: readonly IMarker[];
}

export interface IMarkersModel {
  readonly groups: readonly IMarkersGroup[];
  /** Markers over the limit, not in any group. */
  readonly hidden: number;
  readonly total: number;
}

/** Error, warning, info, then hint; then by position. Stable otherwise. */
export function compareMarkers(a: IMarker, b: IMarker): number {
  return MarkerSeverity.compare(a.severity, b.severity)
    || a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn
    || a.endLineNumber - b.endLineNumber || a.endColumn - b.endColumn;
}

function describe(resource: URI): { label: string; description: string } {
  const label = basename(resource) || resource.toString();
  // `untitled:Untitled-1` has no folder: its dirname is `.`.
  const folder = dirname(resource).path;
  return { label, description: folder === '.' || folder === '/' || folder === resource.path ? '' : folder };
}

/**
 * Groups by resource, groups ordered by their URI string (code unit order, so the order is the same
 * everywhere), rows by `compareMarkers`. Rows past `limit` are counted in `hidden`, taking groups in order.
 */
export function buildMarkersModel(markers: readonly IMarker[], limit = MAX_RENDERED_ROWS): IMarkersModel {
  const byResource = new Map<string, { resource: URI; markers: IMarker[] }>();
  for (const marker of markers) {
    const key = marker.resource.toString();
    const entry = byResource.get(key);
    if (entry) {
      entry.markers.push(marker);
    } else {
      byResource.set(key, { resource: marker.resource, markers: [marker] });
    }
  }
  const groups: IMarkersGroup[] = [];
  let room = limit;
  for (const key of [...byResource.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const { resource, markers: inResource } = byResource.get(key)!;
    inResource.sort(compareMarkers);
    const shown = inResource.slice(0, room);
    room -= shown.length;
    if (shown.length) {
      groups.push({ resource, key, ...describe(resource), total: inResource.length, markers: shown });
    }
  }
  return { groups, hidden: markers.length - (limit - room), total: markers.length };
}
