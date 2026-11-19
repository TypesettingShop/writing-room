import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { extensionResourceLimits } from '../../../services/extensions/common/extensionResources.js';

const imageTypes: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

interface IconEntry {
  url?: string;
  readonly controller: AbortController;
  failed?: boolean;
}

/**
 * The image icons of one tree view, read through the file service up to the icon limit and shown
 * from blob URLs. An image goes into an `<img>`, never inline, so an SVG cannot run script or reach
 * the page's styles. URLs no row uses any more are revoked after each render.
 */
export class TreeViewIcons extends Disposable {
  private readonly entries = new Map<string, IconEntry>();
  private readonly loaded = this._register(new Emitter<void>());
  /** An icon finished loading, so the rows that wait for it can show it. */
  readonly onDidLoad = this.loaded.event;
  private disposed = false;

  constructor(private readonly files: IFileService) {
    super();
  }

  /** The blob URL of `resource` once it is read; starts reading it the first time. */
  get(resource: URI): string | undefined {
    const key = resource.toString();
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { controller: new AbortController() };
      this.entries.set(key, entry);
      void this.read(resource, entry);
    }
    return entry.url;
  }

  /** Revokes every icon but those in `used`, keyed as `get` keys them. */
  retain(used: ReadonlySet<string>): void {
    for (const [key, entry] of this.entries) {
      if (!used.has(key)) {
        this.release(key, entry);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private async read(resource: URI, entry: IconEntry): Promise<void> {
    const type = imageTypes[resource.path.split('.').pop()?.toLowerCase() ?? ''];
    try {
      if (!type) {
        throw new Error('Not an image: ' + resource.toString());
      }
      const { value } = await this.files.readFile(resource, {
        limits: { size: extensionResourceLimits.icon }, signal: entry.controller.signal,
      });
      if (value.byteLength > extensionResourceLimits.icon) {
        throw new Error('The icon is larger than the limit: ' + resource.toString());
      }
      if (this.disposed || this.entries.get(resource.toString()) !== entry) {
        return;
      }
      entry.url = URL.createObjectURL(new Blob([new Uint8Array(value)], { type }));
      this.loaded.fire();
    } catch {
      entry.failed = true;
    }
  }

  private release(key: string, entry: IconEntry): void {
    this.entries.delete(key);
    entry.controller.abort();
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
    }
  }

  override dispose(): void {
    this.disposed = true;
    for (const [key, entry] of this.entries) {
      this.release(key, entry);
    }
    super.dispose();
  }
}
