import { URI } from '../../../../base/common/uri.js';

export const extensionResourceLimits = {
  manifest: 256 * 1024,
  entry: 5 * 1024 * 1024,
  icon: 256 * 1024,
  packageEntry: 16 * 1024 * 1024,
  resource: 8 * 1024 * 1024,
  nls: 256 * 1024,
  webview: 50 * 1024 * 1024,
} as const;

export function resolveExtensionPath(location: string, path: string): URL | undefined {
  if (!path || path !== path.trim() || /[\\?#\u0000-\u001f\u007f]/.test(path)
    || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return undefined;
  }
  try {
    const folder = new URL(location);
    if (!folder.pathname.endsWith('/')) {
      return undefined;
    }
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (/[\\/%\u0000-\u001f\u007f]/.test(decoded)) {
        return undefined;
      }
      if (decoded === '..') {
        if (!segments.length) {
          return undefined;
        }
        segments.pop();
      } else if (decoded && decoded !== '.') {
        segments.push(encodeURIComponent(decoded));
      }
    }
    if (!segments.length || path.endsWith('/')) {
      return undefined;
    }
    const url = new URL('./' + segments.join('/'), folder);
    return url.origin === folder.origin && url.pathname.startsWith(folder.pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}


export function resolveExtensionResource(location: URI, path: string): URI | undefined {
  const url = resolveExtensionPath(location.toString(), path);
  return url && URI.parse(url.href);
}

export function resolveExtensionEntry(location: string, browser: string): URL | undefined {
  const entry = resolveExtensionPath(location, browser);
  if (entry && !entry.pathname.endsWith('.js')) {
    entry.pathname += '.js';
  }
  return entry;
}

export type ExtensionEntryReader = (entry: URI, signal: AbortSignal) => Promise<Uint8Array>;

const entryReaders = new Map<string, ExtensionEntryReader>();

export function registerExtensionEntryReader(scheme: string, reader: ExtensionEntryReader): void {
  const key = scheme.toLowerCase();
  if (entryReaders.has(key)) {
    throw new Error(`Extension entry reader for '${scheme}' already exists.`);
  }
  entryReaders.set(key, reader);
}

export async function readExtensionEntry(entry: URI, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const reader = entryReaders.get(entry.scheme.toLowerCase());
  if (!reader) {
    throw new Error(`No extension entry reader for '${entry.scheme}'.`);
  }
  const bytes = await reader(entry, signal);
  signal.throwIfAborted();
  return bytes;
}
