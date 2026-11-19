import type { IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import type { UriComponents } from '../../../base/common/uri.js';
import { IMarkerService, MarkerSeverity, omittedMarkersNote, MarkerTag, MAX_MARKERS_PER_RESOURCE } from '../../../platform/markers/common/markers.js';
import type { IMarkerData, IMarkerService as MarkerService, IRelatedInformation } from '../../../platform/markers/common/markers.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';
import { ExtHostDiagnosticsProxy, MainThreadDiagnosticsProxy } from '../common/extHost.protocol.diagnostics.js';
import type { ExtHostDiagnosticsShape, MainThreadDiagnosticsShape, MarkerDataDto } from '../common/extHost.protocol.diagnostics.js';

/** Longest message kept, in UTF-16 code units; the rest is cut. */
export const MAX_MESSAGE_LENGTH = 8 * 1024;
/** Longest source, code and collection name kept. */
export const MAX_LABEL_LENGTH = 256;
/** Related places kept for one marker. */
export const MAX_RELATED_INFORMATION = 64;
/** The largest line or column a marker keeps. */
const MAX_POSITION = 2 ** 31 - 1;
/** Schemes a code link may point at. Anything else keeps the code as text. */
const CODE_TARGET_SCHEMES = new Set<string>([Schemas.http, Schemas.https, Schemas.vscodeVfs]);
const SEVERITIES = new Set<number>([MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint]);

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) {
    return undefined;
  }
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function uri(value: unknown): URI | undefined {
  if (URI.isUri(value)) {
    return value;
  }
  try {
    return value && typeof value === 'object' ? URI.revive(value as UriComponents) : undefined;
  } catch {
    return undefined;
  }
}

/** A 1-based line or column: a negative, missing or broken number is the first one. */
function position(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MAX_POSITION) : 1;
}

/** A range with both ends 1-based and the end not before the start; reversed ends are swapped. */
function range(value: Record<string, unknown>) {
  let start = [position(value.startLineNumber), position(value.startColumn)];
  let end = [position(value.endLineNumber), position(value.endColumn)];
  if (end[0] < start[0] || (end[0] === start[0] && end[1] < start[1])) {
    [start, end] = [end, start];
  }
  return { startLineNumber: start[0], startColumn: start[1], endLineNumber: end[0], endColumn: end[1] };
}

function code(value: unknown): IMarkerData['code'] {
  if (typeof value === 'string') {
    return text(value, MAX_LABEL_LENGTH);
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const label = text((value as { value?: unknown }).value, MAX_LABEL_LENGTH);
  if (!label) {
    return undefined;
  }
  const target = uri((value as { target?: unknown }).target);
  return target && CODE_TARGET_SCHEMES.has(target.scheme) ? { value: label, target } : label;
}

function relatedInformation(value: unknown): IRelatedInformation[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: IRelatedInformation[] = [];
  for (const item of value.slice(0, MAX_RELATED_INFORMATION)) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const resource = uri((item as { resource?: unknown }).resource);
    const message = text((item as { message?: unknown }).message, MAX_MESSAGE_LENGTH);
    if (resource && message !== undefined) {
      result.push({ resource, message, ...range(item as Record<string, unknown>) });
    }
  }
  return result.length ? result : undefined;
}

/**
 * A marker the extension host sent, checked: what cannot be used is dropped or made safe, never thrown
 * on. A marker without a message is dropped.
 */
export function sanitizeMarker(value: unknown): IMarkerData | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const data = value as Record<string, unknown>;
  const message = text(data.message, MAX_MESSAGE_LENGTH);
  if (message === undefined) {
    return undefined;
  }
  const severity = typeof data.severity === 'number' && SEVERITIES.has(data.severity) ? data.severity as MarkerSeverity : MarkerSeverity.Error;
  const tags = Array.isArray(data.tags)
    ? [...new Set(data.tags.filter((tag): tag is MarkerTag => tag === MarkerTag.Unnecessary || tag === MarkerTag.Deprecated))]
    : [];
  const result: { -readonly [K in keyof IMarkerData]: IMarkerData[K] } = { severity, message, ...range(data) };
  const source = text(data.source, MAX_LABEL_LENGTH);
  if (source !== undefined) {
    result.source = source;
  }
  const markerCode = code(data.code);
  if (markerCode !== undefined) {
    result.code = markerCode;
  }
  const related = relatedInformation(data.relatedInformation);
  if (related) {
    result.relatedInformation = related;
  }
  if (tags.length) {
    result.tags = tags;
  }
  return result;
}

/** Whether a collection name can be part of an owner. */
function checkCollection(collection: unknown): string {
  if (typeof collection !== 'string' || !collection || collection.length > MAX_LABEL_LENGTH) {
    throw new Error('Expected a diagnostic collection name.');
  }
  return collection;
}

/**
 * Takes the diagnostics of one extension host into the marker service. A marker's owner is the
 * extension's identifier and the collection's name, so one extension can neither change nor clear what
 * another extension's collection of the same name holds. Removing an extension, or stopping the host,
 * removes what it owned. Changes from other owners go to the host, for `getDiagnostics`.
 */
export class MainThreadDiagnostics implements MainThreadDiagnosticsShape, IDisposable {
  /** The owners each extension of this host has written, by extension key. */
  private readonly owners = new Map<string, Set<string>>();
  /** Resources the host last heard of with markers from outside it. */
  private readonly mirrored = new Set<string>();
  private readonly listener: IDisposable;

  constructor(
    private readonly proxy: ExtHostDiagnosticsShape,
    private readonly markers: MarkerService,
    private readonly extensionId: (key: string) => string | undefined,
  ) {
    this.listener = markers.onMarkerChanged(resources => this.forward(resources));
    const existing = new Map<string, URI>();
    for (const marker of markers.read()) {
      existing.set(marker.resource.toString(), marker.resource);
    }
    this.forward([...existing.values()]);
  }

  async $changeMany(extension: string, collection: string, entries: unknown): Promise<void> {
    const owner = this.owner(extension, collection);
    if (!Array.isArray(entries)) {
      throw new Error('Expected diagnostic entries.');
    }
    for (const entry of entries) {
      const resource = Array.isArray(entry) ? uri(entry[0]) : undefined;
      if (!resource) {
        continue;
      }
      this.markers.changeOne(owner, resource, checkMarkers(Array.isArray(entry[1]) ? entry[1] : []));
    }
  }

  async $clear(extension: string, collection: string): Promise<void> {
    this.markers.changeAll(this.owner(extension, collection), []);
  }

  /** Clears the markers of an extension that was removed or failed. */
  remove(extension: string): void {
    for (const owner of this.owners.get(extension) ?? []) {
      this.markers.changeAll(owner, []);
    }
    this.owners.delete(extension);
  }

  dispose(): void {
    this.listener.dispose();
    for (const extension of [...this.owners.keys()]) {
      this.remove(extension);
    }
  }

  private owner(extension: unknown, collection: unknown): string {
    const id = typeof extension === 'string' ? this.extensionId(extension) : undefined;
    if (!id) {
      throw new Error('The extension is not registered.');
    }
    const owner = id + ':' + checkCollection(collection);
    let owned = this.owners.get(extension as string);
    if (!owned) {
      owned = new Set();
      this.owners.set(extension as string, owned);
    }
    owned.add(owner);
    return owner;
  }

  private isOwn(owner: string): boolean {
    for (const owned of this.owners.values()) {
      if (owned.has(owner)) {
        return true;
      }
    }
    return false;
  }

  private forward(resources: readonly URI[]): void {
    const data: [URI, MarkerDataDto[]][] = [];
    for (const resource of resources) {
      const key = resource.toString();
      const foreign = this.markers.read({ resource }).filter(marker => !this.isOwn(marker.owner));
      if (!foreign.length && !this.mirrored.has(key)) {
        continue;
      }
      if (foreign.length) {
        this.mirrored.add(key);
      } else {
        this.mirrored.delete(key);
      }
      data.push([resource, foreign.map(({ owner: _owner, resource: _resource, ...marker }) => marker)]);
    }
    if (data.length) {
      void this.proxy.$acceptMarkersChange(data).catch(() => {});
    }
  }
}

/**
 * Checks the markers of one resource. The extension host sends at most `MAX_MARKERS_PER_RESOURCE` and a
 * note on the rest; a longer list is cut the same way before its items are checked, so a host cannot
 * make the workbench check or keep more.
 */
export function checkMarkers(list: readonly unknown[]): IMarkerData[] {
  if (list.length <= MAX_MARKERS_PER_RESOURCE + 1) {
    return list.map(sanitizeMarker).filter((marker): marker is IMarkerData => !!marker);
  }
  const rank = (item: unknown) => {
    const severity = item && typeof item === 'object' ? (item as { severity?: unknown }).severity : undefined;
    return typeof severity === 'number' && SEVERITIES.has(severity) ? severity : MarkerSeverity.Error;
  };
  const kept: IMarkerData[] = [];
  let seen = 0;
  for (const severity of [MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint]) {
    for (const item of list) {
      if (kept.length === MAX_MARKERS_PER_RESOURCE) {
        break;
      }
      if (rank(item) === severity) {
        seen++;
        const marker = sanitizeMarker(item);
        if (marker) {
          kept.push(marker);
        }
      }
    }
  }
  // Every item is ranked at most once, so what was not looked at is the rest of the list.
  return kept.length && seen < list.length ? [...kept, omittedMarkersNote(list.length - seen, kept.at(-1)!)] : kept;
}

mainThreadCustomers.register('diagnostics', ({ rpc, instantiation, getExtension }) => {
  const markers = instantiation.invokeFunction(accessor => accessor.get(IMarkerService));
  const main = new MainThreadDiagnostics(rpc.getProxy(ExtHostDiagnosticsProxy), markers, key => getExtension(key)?.id);
  rpc.set(MainThreadDiagnosticsProxy, main);
  return { remove: key => main.remove(key), dispose: () => main.dispose() };
});
