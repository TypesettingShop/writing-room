import { toDisposable } from '../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { ICommandService } from '../../commands/common/commands.js';
import { registerSingleton } from '../../instantiation/common/extensions.js';
import { IQuickInputService } from '../../quickinput/common/quickInput.js';
import { EXTERNAL_SCHEMES, IOpenerService, REFUSED_SCHEMES } from '../common/opener.js';
import type { IOpener, OpenOptions } from '../common/opener.js';

function toUri(target: URI | string): URI | undefined {
  if (typeof target !== 'string') {
    return target;
  }
  try {
    return URI.parse(target.trim());
  } catch {
    return undefined;
  }
}

/** The arguments of `command:id?args`: a JSON array, or one JSON value; none without a query. */
function commandArguments(query: string, rawQuery?: string): unknown[] | undefined {
  if (!query) {
    return [];
  }
  // Decoded first; then, as VS Code retries, as written, for JSON whose text holds a `%` sequence.
  const candidates = [query];
  if (rawQuery !== undefined) {
    candidates.push(rawQuery);
  } else {
    try {
      candidates.unshift(decodeURIComponent(query));
    } catch {
      // Not percent-encoded: read as written.
    }
  }
  for (const text of candidates) {
    try {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value) ? value : [value];
    } catch {
      // Try the next reading.
    }
  }
  return undefined;
}

export class OpenerService implements IOpenerService {
  declare readonly _serviceBrand: undefined;

  /** Latest first. */
  private readonly openers: IOpener[] = [];

  constructor(
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @ICommandService private readonly commands: ICommandService,
  ) {}

  registerOpener(opener: IOpener): IDisposable {
    this.openers.unshift(opener);
    return toDisposable(() => {
      const index = this.openers.indexOf(opener);
      if (index !== -1) {
        this.openers.splice(index, 1);
      }
    });
  }

  async open(target: URI | string, options?: OpenOptions): Promise<boolean> {
    const resource = toUri(target);
    if (!resource) {
      return false;
    }
    const scheme = resource.scheme.toLowerCase();
    if (REFUSED_SCHEMES.has(scheme)) {
      return false;
    }
    if (EXTERNAL_SCHEMES.has(scheme)) {
      const address = scheme === 'mailto' ? resource.toString(true) : externalWebAddress(resource);
      return address ? this.openExternal(address) : false;
    }
    if (scheme === 'command') {
      return this.runCommand(resource, options);
    }
    for (const opener of [...this.openers]) {
      if (await opener.open(resource, options)) {
        return true;
      }
    }
    return false;
  }

  /** Shows the whole address and opens it in a new tab once the user agrees; the page gets no handle on this one. */
  private async openExternal(address: string): Promise<boolean> {
    const choice = await this.quickInput.pick([
      { id: 'open', label: 'Open', detail: address },
      { id: 'cancel', label: 'Cancel' },
    ], { title: 'Do you want to open this external address?' });
    if (choice?.id !== 'open') {
      return false;
    }
    globalThis.open(address, '_blank', 'noopener,noreferrer');
    return true;
  }

  private async runCommand(resource: URI, options: OpenOptions | undefined): Promise<boolean> {
    const id = resource.path;
    const allowed = options?.allowCommands;
    if (!id || !(allowed === true || (Array.isArray(allowed) && allowed.includes(id)))) {
      return false;
    }
    const args = commandArguments(resource.query, resource.rawQuery);
    if (!args) {
      return false;
    }
    await this.commands.executeCommand(id, ...args);
    return true;
  }
}

registerSingleton(IOpenerService, OpenerService);

function externalWebAddress(resource: URI): string | undefined {
  try {
    return resource.toHttpURL().href;
  } catch {
    return undefined;
  }
}
