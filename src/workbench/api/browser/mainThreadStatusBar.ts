import type { IDisposable } from '../../../base/common/lifecycle.js';
import { StatusbarAlignment } from '../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntryAccessor, IStatusbarService } from '../../services/statusbar/browser/statusbar.js';
import type { MainThreadStatusBarShape, StatusBarEntryDto } from '../common/extHost.protocol.js';

export class MainThreadStatusBar implements MainThreadStatusBarShape, IDisposable {
  private readonly entries = new Map<string, Map<string, IStatusbarEntryAccessor>>();

  constructor(
    private readonly statusbar: IStatusbarService,
    private readonly extensionId: (key: string) => string | undefined,
  ) {}

  async $setEntry(extension: string, id: string, entry: StatusBarEntryDto): Promise<void> {
    const extensionId = this.extensionId(extension);
    if (!extensionId) {
      return;
    }
    const entries = this.entries.get(extension) ?? new Map();
    this.entries.set(extension, entries);
    const data = {
      name: entry.name ?? extensionId, text: entry.text, tooltip: entry.tooltip,
      command: typeof entry.command === 'object'
        ? { id: entry.command.id, arguments: entry.command.args }
        : entry.command,
    };
    const existing = entries.get(id);
    if (existing) {
      existing.update(data);
    } else {
      const alignment = entry.alignment === 2 ? StatusbarAlignment.RIGHT : StatusbarAlignment.LEFT;
      const priority = Number.isFinite(entry.priority) ? entry.priority! : 0;
      entries.set(id, this.statusbar.addEntry(data, extensionId + '.' + id, alignment, priority));
    }
  }

  async $disposeEntry(extension: string, id: string): Promise<void> {
    const entries = this.entries.get(extension);
    entries?.get(id)?.dispose();
    entries?.delete(id);
  }

  remove(extension: string): void {
    for (const entry of this.entries.get(extension)?.values() ?? []) {
      entry.dispose();
    }
    this.entries.delete(extension);
  }

  dispose(): void {
    for (const extension of this.entries.keys()) {
      this.remove(extension);
    }
  }
}
