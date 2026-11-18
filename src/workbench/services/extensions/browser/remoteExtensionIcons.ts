import { DeferredIcon } from '../../../../base/common/themables.js';

interface ResourceIcon {
  readonly icon: DeferredIcon;
  readonly controller: AbortController;
  requested: boolean;
  objectUrl?: string;
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
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    try {
      const response = await fetch(icon.href, { mode: 'cors', credentials: 'omit', redirect: 'error', signal });
      if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${response.status} or unsupported image response`);
      }
      const blob = await response.blob();
      signal.throwIfAborted();
      entry.objectUrl = URL.createObjectURL(blob);
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
