import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { IFileStat } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { isInsideRoots, resolveDialogPath, validateFileName } from '../common/dialogPaths.js';
import type { FileFilter, IOpenDialogOptions, ISaveDialogOptions } from '../common/dialogs.js';

type EntryKind = 'accept' | 'type' | 'parent' | 'folder' | 'file';

interface IDialogEntry extends IQuickPickItem {
  readonly kind: EntryKind;
  readonly resource?: URI;
}

/** A path typed into the dialog, read against the file system. */
interface ITypedPath {
  readonly resource: URI;
  /** Whether a folder is there; `undefined` when nothing is. */
  readonly directory: boolean | undefined;
}

/** How a folder is shown: its path with a slash at the end, as VS Code's simple dialog shows it. */
export function displayFolder(folder: URI): string {
  return folder.path.endsWith('/') ? folder.path : folder.path + '/';
}

/** The extensions the filters let through, lower case without the dot; `undefined` lets every file through. */
function allowedExtensions(filters: readonly FileFilter[] | undefined): Set<string> | undefined {
  if (!filters?.length) {
    return undefined;
  }
  const extensions = new Set<string>();
  for (const filter of filters) {
    for (const extension of filter.extensions) {
      if (extension === '*' || extension === '') {
        return undefined;
      }
      extensions.add(extension.replace(/^\./, '').toLowerCase());
    }
  }
  return extensions;
}

function passes(name: string, extensions: Set<string> | undefined): boolean {
  if (!extensions) {
    return true;
  }
  const lower = name.toLowerCase();
  return [...extensions].some(extension => lower.endsWith('.' + extension));
}

/**
 * The file dialog of the workbench, made of quick inputs: a list of what the folder holds (`..`, its
 * folders, its files) that the user walks with the keyboard or the mouse, and an entry that takes a
 * typed path, absolute or relative to the folder. Only the workspace folders can be reached; a path
 * that leaves them, once `.` and `..` are resolved, is refused. Any question closed without an answer
 * — Escape, a click elsewhere, another quick input taking the place — cancels the whole dialog.
 */
export class SimpleFileDialog {
  constructor(
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @IFileService private readonly fileService: IFileService,
    @IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
  ) {}

  private roots(): URI[] {
    return this.workspace.getWorkspace().folders.map(folder => folder.uri);
  }

  async showOpenDialog(options: IOpenDialogOptions): Promise<URI[] | undefined> {
    const roots = this.roots();
    if (!roots.length) {
      return undefined;
    }
    const canSelectFolders = options.canSelectFolders === true;
    // As in VS Code, a dialog that asks for neither picks files.
    const canSelectFiles = options.canSelectFiles === true || !canSelectFolders;
    const title = options.title ?? (canSelectFiles && canSelectFolders ? 'Open' : canSelectFolders ? 'Open Folder' : 'Open File');
    const extensions = allowedExtensions(options.filters);
    let folder = (await this.startingPoint(options.defaultUri, roots)).folder;
    for (;;) {
      const children = await this.children(folder, roots);
      if (!children) {
        if (isEqual(folder, roots[0])) {
          return undefined;
        }
        folder = roots[0];
        continue;
      }
      const items: IDialogEntry[] = [];
      if (canSelectFolders) {
        items.push({ kind: 'accept', label: options.openLabel || 'Open', description: displayFolder(folder), detail: 'Select this folder' });
      }
      items.push(...this.navigation(folder, roots, 'Type a Path...'));
      items.push(...this.listing(children, canSelectFiles ? extensions : null));
      const picked = await this.quickInput.pick(items, { title, placeHolder: this.placeholder(folder) });
      if (!picked) {
        return undefined;
      }
      switch (picked.kind) {
        case 'accept':
          return [folder];
        case 'parent':
        case 'folder':
          folder = picked.resource!;
          continue;
        case 'file':
          return [picked.resource!];
        case 'type': {
          const typed = await this.typePath(title, folder, roots, displayFolder(folder), async target => {
            if (target.directory === undefined) {
              return 'Please enter a path that exists.';
            }
            return !target.directory && !canSelectFiles ? 'Please select a folder.' : undefined;
          });
          if (!typed) {
            return undefined;
          }
          if (typed.directory) {
            folder = typed.resource;
            continue;
          }
          if (typed.directory === false) {
            return [typed.resource];
          }
          // Gone since it was typed: show the folder again.
          continue;
        }
      }
    }
  }

  async showSaveDialog(options: ISaveDialogOptions): Promise<URI | undefined> {
    const roots = this.roots();
    if (!roots.length) {
      return undefined;
    }
    const title = options.title ?? 'Save As';
    const extensions = allowedExtensions(options.filters);
    let { folder, name } = await this.startingPoint(options.defaultUri, roots);
    for (;;) {
      const children = await this.children(folder, roots);
      if (!children) {
        if (isEqual(folder, roots[0])) {
          return undefined;
        }
        folder = roots[0];
        continue;
      }
      const items: IDialogEntry[] = [];
      if (name) {
        const target = joinPath(folder, name);
        items.push({ kind: 'accept', label: options.saveLabel || 'Save', description: target.path, resource: target });
      }
      items.push(...this.navigation(folder, roots, 'Type a Name or Path...'));
      items.push(...this.listing(children, extensions));
      const picked = await this.quickInput.pick(items, { title, placeHolder: this.placeholder(folder) });
      if (!picked) {
        return undefined;
      }
      let target: URI;
      switch (picked.kind) {
        case 'parent':
        case 'folder':
          folder = picked.resource!;
          continue;
        case 'accept':
        case 'file':
          target = picked.resource!;
          break;
        case 'type': {
          const typed = await this.typePath(title, folder, roots, name ?? '', async target => {
            if (target.directory) {
              return undefined;
            }
            const nameError = validateFileName(basename(target.resource));
            if (nameError) {
              return nameError;
            }
            const parent = await this.stat(dirname(target.resource));
            return parent?.isDirectory ? undefined : 'Please enter a path that exists.';
          });
          if (!typed) {
            return undefined;
          }
          if (typed.directory) {
            folder = typed.resource;
            continue;
          }
          target = typed.resource;
          break;
        }
      }
      folder = dirname(target);
      name = basename(target);
      const answer = await this.confirmTarget(target, title);
      if (answer === 'cancel') {
        return undefined;
      }
      if (answer === 'ok') {
        return target;
      }
    }
  }

  /** The folder to start in and the name to suggest, from `defaultUri` when it is in the workspace. */
  private async startingPoint(defaultUri: URI | undefined, roots: readonly URI[]): Promise<{ folder: URI; name: string | undefined }> {
    const suggested = defaultUri && validateFileName(basename(defaultUri)) === undefined ? basename(defaultUri) : undefined;
    if (!defaultUri || !isInsideRoots(defaultUri, roots)) {
      return { folder: roots[0], name: suggested };
    }
    const stat = await this.stat(defaultUri);
    if (stat?.isDirectory) {
      return { folder: defaultUri, name: undefined };
    }
    const parent = dirname(defaultUri);
    const parentStat = isInsideRoots(parent, roots) ? await this.stat(parent) : undefined;
    return { folder: parentStat?.isDirectory ? parent : roots[0], name: suggested };
  }

  /** The folder's entries, or `undefined` when it is not a folder in the workspace (any more). */
  private async children(folder: URI, roots: readonly URI[]): Promise<readonly IFileStat[] | undefined> {
    if (!isInsideRoots(folder, roots)) {
      return undefined;
    }
    try {
      const stat = await this.fileService.resolve(folder);
      return stat.isDirectory ? stat.children ?? [] : undefined;
    } catch {
      return undefined;
    }
  }

  private navigation(folder: URI, roots: readonly URI[], typeLabel: string): IDialogEntry[] {
    const entries: IDialogEntry[] = [{
      kind: 'type', label: typeLabel, detail: 'A path in the workspace folder, absolute or relative to this folder',
    }];
    if (!roots.some(root => isEqual(root, folder))) {
      entries.push({ kind: 'parent', label: '..', description: 'Parent folder', resource: dirname(folder) });
    }
    return entries;
  }

  /** Folders first, then the files the extensions let through (`null`: no files), each by name. */
  private listing(children: readonly IFileStat[], extensions: Set<string> | undefined | null): IDialogEntry[] {
    const byName = (a: IFileStat, b: IFileStat) => a.name.localeCompare(b.name);
    const folders = children.filter(child => child.isDirectory).sort(byName)
      .map((child): IDialogEntry => ({ kind: 'folder', label: child.name + '/', resource: child.resource }));
    const files = extensions === null ? [] : children.filter(child => !child.isDirectory && passes(child.name, extensions)).sort(byName)
      .map((child): IDialogEntry => ({ kind: 'file', label: child.name, resource: child.resource }));
    return [...folders, ...files];
  }

  private placeholder(folder: URI): string {
    return displayFolder(folder) + ' — choose an item, or type to filter';
  }

  /**
   * Asks for a path. `check` says why a path that is inside the workspace still will not do. The
   * answer is read again once accepted, as the file system may have changed meanwhile.
   */
  private async typePath(
    title: string, folder: URI, roots: readonly URI[], value: string, check: (target: ITypedPath) => Promise<string | undefined>,
  ): Promise<ITypedPath | undefined> {
    const read = async (text: string): Promise<ITypedPath | string> => {
      const resolved = resolveDialogPath(text, folder, roots);
      if (typeof resolved === 'string') {
        return resolved;
      }
      const stat = await this.stat(resolved.resource);
      if (resolved.folder && !stat?.isDirectory) {
        return stat ? 'Please enter a folder, not a file.' : 'Please enter a path that exists.';
      }
      return { resource: resolved.resource, directory: stat?.isDirectory };
    };
    const typed = await this.quickInput.input({
      title,
      value,
      prompt: `Type a path in the workspace folder, absolute or relative to ${displayFolder(folder)}`,
      validateInput: async text => {
        const target = await read(text);
        return typeof target === 'string' ? target : await check(target);
      },
    });
    if (typed === undefined) {
      return undefined;
    }
    const target = await read(typed);
    return typeof target === 'string' ? { resource: folder, directory: true } : target;
  }

  /** Whether to save at `target`: `ok`, or `retry` to choose again, or `cancel`. */
  private async confirmTarget(target: URI, title: string): Promise<'ok' | 'retry' | 'cancel'> {
    const stat = await this.stat(target);
    if (!stat) {
      return 'ok';
    }
    if (stat.isDirectory) {
      return 'retry';
    }
    const answer = await this.quickInput.pick([
      { id: 'replace', label: 'Replace', detail: `Overwrite ${target.path}.` },
      { id: 'cancel', label: 'Cancel', detail: 'Choose another name.' },
    ], { title: `${title}: ${basename(target)} already exists. Do you want to replace it?` });
    return answer === undefined ? 'cancel' : answer.id === 'replace' ? 'ok' : 'retry';
  }

  private async stat(resource: URI): Promise<IFileStat | undefined> {
    try {
      return await this.fileService.stat(resource);
    } catch {
      return undefined;
    }
  }
}
