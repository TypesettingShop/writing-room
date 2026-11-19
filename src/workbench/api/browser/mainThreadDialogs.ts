import { Schemas } from '../../../base/common/network.js';
import { normalize } from '../../../base/common/path.js';
import { basename, joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { hasForbiddenPathCharacter, isInsideRoots, validateFileName } from '../../services/dialogs/common/dialogPaths.js';
import { IFileDialogService } from '../../services/dialogs/common/dialogs.js';
import type { FileFilter, IOpenDialogOptions, ISaveDialogOptions } from '../../services/dialogs/common/dialogs.js';
import { MainThreadDialogsProxy } from '../common/extHost.protocol.dialogs.js';
import type { MainThreadDialogOpenOptions, MainThreadDialogSaveOptions, MainThreadDialogsShape } from '../common/extHost.protocol.dialogs.js';
import { mainThreadCustomers } from './mainThreadCustomers.js';

/** Bounds on what an extension may hand the dialogs. */
const MAX_LABEL_LENGTH = 1024;
const MAX_FILTERS = 100;
const MAX_EXTENSIONS = 100;
const MAX_FILTER_TEXT = 256;

function fail(message: string): never {
  throw new TypeError('Invalid dialog options: ' + message);
}

function readBoolean(value: unknown, name: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    fail(name + ' must be a boolean.');
  }
  return value;
}

function readLabel(value: unknown, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > MAX_LABEL_LENGTH) {
    fail(`${name} must be a string of at most ${MAX_LABEL_LENGTH} characters.`);
  }
  // As VS Code: an empty label is no label.
  return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function readFilters(value: unknown): FileFilter[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).length > MAX_FILTERS) {
    fail(`filters must be an object of at most ${MAX_FILTERS} names.`);
  }
  return Object.entries(value).map(([name, extensions]) => {
    if (name.length > MAX_FILTER_TEXT || !Array.isArray(extensions) || extensions.length > MAX_EXTENSIONS
      || extensions.some(extension => typeof extension !== 'string' || extension.length > MAX_FILTER_TEXT)) {
      fail('each filter must name a list of extensions.');
    }
    return { name, extensions: [...extensions] };
  });
}

/**
 * The main thread's side of the dialog API. It trusts nothing the extension sends: the options must
 * have the documented shape, a `defaultUri` outside the workspace folders is dropped, and every URI
 * the dialog gives back is checked again — a workspace scheme, a normalized path inside a workspace
 * folder — before it crosses back.
 */
export class MainThreadDialogs implements MainThreadDialogsShape {
  constructor(
    private readonly dialogs: IFileDialogService,
    private readonly workspace: IWorkspaceContextService,
    private readonly isRegistered: (key: string) => boolean,
  ) {}

  async $showOpenDialog(extension: string, options?: MainThreadDialogOpenOptions): Promise<URI[] | undefined> {
    if (!this.isRegistered(extension)) {
      return undefined;
    }
    const raw = this.readOptions(options);
    const checked: IOpenDialogOptions = {
      defaultUri: this.readDefaultUri(raw.defaultUri),
      openLabel: readLabel(raw.openLabel, 'openLabel'),
      canSelectFiles: readBoolean(raw.canSelectFiles, 'canSelectFiles'),
      canSelectFolders: readBoolean(raw.canSelectFolders, 'canSelectFolders'),
      canSelectMany: readBoolean(raw.canSelectMany, 'canSelectMany'),
      filters: readFilters(raw.filters),
      title: readLabel(raw.title, 'title'),
    };
    const result = await this.dialogs.showOpenDialog(checked);
    if (!result?.length || !this.isRegistered(extension) || !result.every(uri => this.isAllowed(uri))) {
      return undefined;
    }
    return result;
  }

  async $showSaveDialog(extension: string, options?: MainThreadDialogSaveOptions): Promise<URI | undefined> {
    if (!this.isRegistered(extension)) {
      return undefined;
    }
    const raw = this.readOptions(options);
    const checked: ISaveDialogOptions = {
      defaultUri: this.readDefaultUri(raw.defaultUri),
      saveLabel: readLabel(raw.saveLabel, 'saveLabel'),
      filters: readFilters(raw.filters),
      title: readLabel(raw.title, 'title'),
    };
    const result = await this.dialogs.showSaveDialog(checked);
    return result && this.isRegistered(extension) && this.isAllowed(result) ? result : undefined;
  }

  private readOptions(options: unknown): Record<string, unknown> {
    if (options === undefined || options === null) {
      return {};
    }
    if (!isRecord(options)) {
      fail('options must be an object.');
    }
    return options;
  }

  /**
   * A starting place in the workspace, or the default one. A place outside is not offered; only its
   * name, when it can name a file, is suggested in the default folder.
   */
  private readDefaultUri(value: unknown): URI | undefined {
    if (value === undefined) {
      return this.dialogs.defaultFilePath();
    }
    if (!URI.isUri(value)) {
      fail('defaultUri must be a Uri.');
    }
    if (this.isAllowed(value)) {
      return value;
    }
    const folder = this.dialogs.defaultFilePath();
    const name = basename(value);
    return folder && validateFileName(name) === undefined ? joinPath(folder, name) : folder;
  }

  private isAllowed(uri: unknown): uri is URI {
    if (!URI.isUri(uri) || uri.scheme !== Schemas.vscodeVfs || uri.query || uri.fragment || uri.hasEncodedPathSeparator) {
      return false;
    }
    // A path that `.` or `..` would change, or that holds a backslash or a control character, is no workspace path.
    if (normalize(uri.path) !== uri.path || hasForbiddenPathCharacter(uri.path)) {
      return false;
    }
    return isInsideRoots(uri, this.workspace.getWorkspace().folders.map(folder => folder.uri));
  }
}

mainThreadCustomers.register('dialogs', ({ rpc, instantiation, getExtension }) => {
  const dialogs = instantiation.invokeFunction(accessor => new MainThreadDialogs(
    accessor.get(IFileDialogService), accessor.get(IWorkspaceContextService), key => Boolean(getExtension(key))));
  rpc.set(MainThreadDialogsProxy, dialogs);
  return {};
});
