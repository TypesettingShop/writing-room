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


export interface MainThreadRuntimeShape {
  $asBrowserUri(key: string, value: string, forWorker: boolean): Promise<string>;
  $getLocalization(key: string): Promise<{ json: string; uri: string } | undefined>;
  $getEnvironment(key: string): Promise<{ machineId: string; sessionId: string }>;
  $readClipboard(key: string): Promise<string>;
  $writeClipboard(key: string, value: string): Promise<void>;
  $openExternal(key: string, target: URI): Promise<boolean>;
}

export const MainThreadRuntimeProxy = createProxyIdentifier<MainThreadRuntimeShape>('MainThreadRuntime');
