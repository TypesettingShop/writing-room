import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export type ExtensionStateScope = 'global' | 'workspace';

export interface MainThreadStorageShape {
  $initialize(key: string): Promise<{ global: string; workspace: string }>;
  $update(key: string, scope: ExtensionStateScope, name: string, json: string | undefined): Promise<void>;
  $getSecret(key: string, name: string): Promise<string | undefined>;
  $getSecretKeys(key: string): Promise<string[]>;
  $setSecret(key: string, name: string, value: string | undefined): Promise<void>;
}

export interface ExtHostStorageShape {
  $acceptState(key: string, scope: ExtensionStateScope, json: string): void;
  $acceptSecretChange(key: string, name: string): void;
}

export const MainThreadStorageProxy = createProxyIdentifier<MainThreadStorageShape>('MainThreadStorage');
export const ExtHostStorageProxy = createProxyIdentifier<ExtHostStorageShape>('ExtHostStorage');


/** The most one extension host log line takes, in UTF-16 code units with its line feed. */
export const EXTENSION_HOST_LOG_LINE_LIMIT = 64 * 1024;

/**
 * Keeps a line within the limit as it is. A longer line is cut to fit with its line feed, without splitting a
 * surrogate pair, so the next line still starts on a line of its own.
 */
export function boundExtensionHostLogLine(line: string): string {
  if (line.length <= EXTENSION_HOST_LOG_LINE_LIMIT) {
    return line;
  }
  let end = EXTENSION_HOST_LOG_LINE_LIMIT - 1;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return line.slice(0, end) + '\n';
}

export interface MainThreadRuntimeShape {
  $logExtensionHost(line: string): Promise<void>;
  $asBrowserUri(key: string, value: string, forWorker: boolean): Promise<string>;
  $getLocalization(key: string): Promise<{ json: string; uri: string } | undefined>;
  $getEnvironment(key: string): Promise<{ machineId: string; sessionId: string }>;
  $readClipboard(key: string): Promise<string>;
  $writeClipboard(key: string, value: string): Promise<void>;
  $openExternal(key: string, target: URI): Promise<boolean>;
}

export const MainThreadRuntimeProxy = createProxyIdentifier<MainThreadRuntimeShape>('MainThreadRuntime');
