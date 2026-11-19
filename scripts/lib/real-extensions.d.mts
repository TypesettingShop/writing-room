// Types for real-extensions.mjs, for the TypeScript tests and fixture routes that import it.
export interface PinnedFile { readonly url: string; readonly sha256: string; readonly size: number }
export interface ExtensionPin {
  readonly id: string;
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
  readonly role?: string;
  readonly vsix: PinnedFile;
  readonly sha256File: { readonly url: string };
  readonly signature: PinnedFile;
  readonly publicKey: string;
}
export interface Pins {
  readonly publicKeys: Readonly<Record<string, PinnedFile>>;
  readonly extensions: readonly ExtensionPin[];
}
export interface CachedFile { readonly path: string; readonly url: string; readonly sha256?: string; readonly limit: number }
export interface ZipReader {
  readonly names: readonly string[];
  has(name: string): boolean;
  read(name: string): Buffer | undefined;
}

export const repositoryRoot: string;
export const defaultPinsPath: string;
export const defaultCacheDir: string;
export const limits: Readonly<Record<'vsix' | 'signature' | 'publicKey' | 'sha256File' | 'pins' | 'unpacked' | 'entries' | 'entry' | 'pathBytes', number>>;
export const allowedHosts: readonly string[];
export const requestTimeout: number;
export class IntegrityError extends Error {}
export function sha256(bytes: Uint8Array): string;
export function readPins(path?: string): Promise<Pins>;
export function selectPins(pins: Pins, ids: readonly string[]): readonly ExtensionPin[];
export function packageBaseName(pin: ExtensionPin): string;
export function cachedFiles(pins: Pins, pin: ExtensionPin, cacheDir?: string): Record<'vsix' | 'signature' | 'sha256File' | 'publicKey', CachedFile>;
export function readVerified(file: CachedFile): Promise<Buffer | undefined>;
export function writeVerified(file: CachedFile, bytes: Uint8Array): Promise<void>;
export function download(url: string, limit: number, request?: typeof fetch): Promise<Buffer>;
export function readZip(bytes: Uint8Array): ZipReader;
export function extractVsix(bytes: Uint8Array, destination: string): Promise<void>;
export function verifyPackageSignature(vsix: Uint8Array, sigzip: Uint8Array, publicKeyPem: Uint8Array | string): boolean;
export function resolveContained(root: string, urlPath: string): string | undefined;
