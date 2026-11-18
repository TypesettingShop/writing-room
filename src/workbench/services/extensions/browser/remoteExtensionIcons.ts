import { DeferredIcon } from '../../../../base/common/themables.js';
import { fetchBoundedResource } from '../../../../base/parts/request/common/boundedFetch.js';
import { extensionResourceLimits } from '../common/extensionResources.js';

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
    try {
      const { bytes, contentType } = await fetchBoundedResource(icon.href, {
        limit: extensionResourceLimits.icon, signal: controller.signal, contentTypePrefix: 'image/',
      });
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
