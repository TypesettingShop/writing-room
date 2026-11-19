import { DeferredIcon } from '../../../../base/common/themables.js';
import { fetchBoundedResource } from '../../../../base/parts/request/common/boundedFetch.js';
import { extensionResourceLimits } from '../common/extensionResources.js';

interface ResourceIcon {
  readonly icon: DeferredIcon;
  readonly controller: AbortController;
  requested: boolean;
  objectUrl?: string;
}

/** Reads an icon of at most `limit` bytes. Rejects anything that is not an image. */
export type ExtensionIconReader = (url: URL, limit: number, signal: AbortSignal) => Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }>;

const fetchIcon: ExtensionIconReader = async (url, limit, signal) =>
  fetchBoundedResource(url.href, { limit, signal, contentTypePrefix: 'image/' });

// Icons of package installs live in user data, which only a workbench service can read. Its reader is
// registered once the workbench starts, possibly after an early activation asked for an icon.
const readers = new Map<string, ExtensionIconReader>([['http:', fetchIcon], ['https:', fetchIcon]]);
const waiting = new Map<string, Set<() => void>>();

export function registerExtensionIconReader(scheme: string, reader: ExtensionIconReader): { dispose(): void } {
  const protocol = scheme.toLowerCase() + ':';
  if (readers.has(protocol)) {
    throw new Error(`Extension icon reader for '${scheme}' already exists.`);
  }
  readers.set(protocol, reader);
  for (const resume of waiting.get(protocol) ?? []) {
    resume();
  }
  waiting.delete(protocol);
  return {
    dispose: () => {
      if (readers.get(protocol) === reader) {
        readers.delete(protocol);
      }
    },
  };
}

function iconReader(protocol: string, signal: AbortSignal): Promise<ExtensionIconReader> {
  const reader = readers.get(protocol);
  if (reader) {
    return Promise.resolve(reader);
  }
  return new Promise((resolve, reject) => {
    const callbacks = waiting.get(protocol) ?? new Set();
    waiting.set(protocol, callbacks);
    const resume = () => {
      signal.removeEventListener('abort', abort);
      resolve(readers.get(protocol)!);
    };
    const abort = () => {
      callbacks.delete(resume);
      reject(signal.reason);
    };
    callbacks.add(resume);
    signal.addEventListener('abort', abort, { once: true });
  });
}

let nextIconId = 0;

export class RemoteExtensionIcons {
  private readonly extensions = new Map<string, Map<string, ResourceIcon>>();

  constructor(private readonly workbench: HTMLElement) {}

  resolve(extension: string, url: URL): URL {
    const icons = this.extensions.get(extension) ?? new Map();
    this.extensions.set(extension, icons);
    let entry = icons.get(url.href);
    if (!entry) {
      entry = { icon: new DeferredIcon(url, '--wr-extension-icon-' + ++nextIconId), controller: new AbortController(), requested: false };
      icons.set(url.href, entry);
    }
    return entry.icon;
  }

  activate(extension: string): void {
    for (const entry of this.extensions.get(extension)?.values() ?? []) {
      if (!entry.requested) {
        entry.requested = true;
        void this.load(extension, entry);
      }
    }
  }

  private async load(extension: string, entry: ResourceIcon): Promise<void> {
    const { icon, controller } = entry;
    try {
      const read = await iconReader(new URL(icon.href).protocol, controller.signal);
      const { bytes, contentType } = await read(new URL(icon.href), extensionResourceLimits.icon, controller.signal);
      controller.signal.throwIfAborted();
      entry.objectUrl = URL.createObjectURL(new Blob([bytes], { type: contentType }));
      this.workbench.style.setProperty(icon.styleProperty, `url("${entry.objectUrl}")`);
      this.workbench.style.setProperty(icon.styleProperty + '-fallback', 'none');
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn(`[${extension}] Could not load icon '${icon.href}'.`, error);
      }
    }
  }

  remove(extension: string): void {
    for (const { controller, icon, objectUrl } of this.extensions.get(extension)?.values() ?? []) {
      controller.abort();
      this.workbench.style.removeProperty(icon.styleProperty);
      this.workbench.style.removeProperty(icon.styleProperty + '-fallback');
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
    this.extensions.delete(extension);
  }

  dispose(): void {
    for (const extension of this.extensions.keys()) {
      this.remove(extension);
    }
  }
}
