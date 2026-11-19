import type { URI } from '../../../base/common/uri.js';
import type { IMarkerData } from '../../../platform/markers/common/markers.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/**
 * A diagnostic as a marker: 1-based lines and columns, the end column exclusive. URIs cross as RPC URI
 * values and arrive as `URI`; the workbench checks every field again (`sanitizeMarker`).
 */
export type MarkerDataDto = IMarkerData;

/** A resource and what replaces its markers; `undefined` removes them. */
export type MarkerChangeDto = readonly [URI, readonly MarkerDataDto[] | undefined];

export interface MainThreadDiagnosticsShape {
  /**
   * Replaces the markers of one collection of `extension` for each resource. `collection` names the
   * collection within the extension; the workbench owner adds the extension's identifier to it.
   */
  $changeMany(extension: string, collection: string, entries: readonly MarkerChangeDto[]): Promise<void>;
  /** Removes every marker of that collection. */
  $clear(extension: string, collection: string): Promise<void>;
}

export interface ExtHostDiagnosticsShape {
  /** The markers of owners outside this host, for each resource whose markers changed. */
  $acceptMarkersChange(data: readonly (readonly [URI, readonly MarkerDataDto[]])[]): Promise<void>;
}

export const MainThreadDiagnosticsProxy = createProxyIdentifier<MainThreadDiagnosticsShape>('MainThreadDiagnostics');
export const ExtHostDiagnosticsProxy = createProxyIdentifier<ExtHostDiagnosticsShape>('ExtHostDiagnostics');
