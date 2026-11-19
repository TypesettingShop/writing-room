import type { IExtensionManifest } from '../../../../platform/extensions/common/extensions.js';

export const enum ExtensionHostMessage {
  Ready = 'ready',
  Initialize = 'initialize',
  Initialized = 'initialized',
  Terminate = 'terminate',
  Ping = 'ping',
  Pong = 'pong',
}

export interface HostExtensionDescription {
  readonly id: string;
  readonly key: string;
  readonly location: string;
  readonly entry: string;
  readonly manifest: IExtensionManifest;
  readonly activationEvents: readonly string[];
  readonly isBuiltin?: boolean;
  readonly runtime?: { readonly workspaceId?: string; readonly locale: string };
  readonly views?: readonly string[];
}

export type ExtensionHostStatus =
  | { readonly state: 'inactive' | 'activating' | 'active' }
  | { readonly state: 'failed'; readonly message: string };

export type HostControlMessage =
  | { kind: ExtensionHostMessage.Initialize; extensions: HostExtensionDescription[] }
  | { kind: ExtensionHostMessage.Ready | ExtensionHostMessage.Initialized | ExtensionHostMessage.Terminate }
  | { kind: ExtensionHostMessage.Ping | ExtensionHostMessage.Pong; sequence: number };
