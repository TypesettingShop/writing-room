import { basename, joinPath } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { IFileStat } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { validateFileName } from '../../../services/dialogs/common/dialogPaths.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { describeFileError, IExplorerService } from './explorerService.js';

export const UPLOAD_COMMAND_ID = 'explorer.upload';
export const UPLOAD_LABEL = 'Upload...';
export const DOWNLOAD_COMMAND_ID = 'explorer.download';
export const DOWNLOAD_LABEL = 'Download';

const MiB = 1024 * 1024;
/** The largest file one upload takes. */
export const MAX_UPLOAD_FILE_SIZE = 50 * MiB;
/** The most bytes one upload takes, all its files together. */
export const MAX_UPLOAD_TOTAL_SIZE = 200 * MiB;

/** One thing the user gave to upload: a file with its bytes, or a folder, which is not taken. */
export interface IUploadEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** The bytes of a file; only `size` and `arrayBuffer` are used. */
  readonly file?: Pick<File, 'size' | 'arrayBuffer'>;
}

export function fileEntry(file: File): IUploadEntry {
  return { name: file.name, isDirectory: false, file };
}

/**
 * The files and folders of a drop, taken while the drop event runs (its data is gone after it).
 * Text, links and other items that are not files are left out.
 */
export function entriesOfDataTransfer(data: DataTransfer): IUploadEntry[] {
  const entries: IUploadEntry[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') {
      continue;
    }
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry?.isDirectory) {
      entries.push({ name: entry.name, isDirectory: true });
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      entries.push(fileEntry(file));
    }
  }
  return entries;
}

function formatSize(bytes: number): string {
  const mib = bytes / MiB;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MB`;
}

/**
 * Lets the user choose files from the computer with `<input type="file" multiple>` (VS Code's
 * `triggerUpload`). Resolves to the files, or to `undefined` when the chooser is cancelled.
 */
export function chooseFilesToUpload(document: Document): Promise<File[] | undefined> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.hidden = true;
    let done = false;
    const finish = (files: File[] | undefined) => {
      if (!done) {
        done = true;
        input.remove();
        resolve(files);
      }
    };
    input.addEventListener('change', () => finish(input.files?.length ? Array.from(input.files) : undefined));
    input.addEventListener('cancel', () => finish(undefined));
    document.body.append(input);
    input.click();
  });
}

/**
 * Saves `bytes` as a file named `name` on the computer (VS Code's `triggerDownload`): a Blob URL that
 * a `<a download>` link opens. The browser has taken the URL once the click has run, so it is let go
 * on the next task, as VS Code does.
 */
export function triggerDownload(document: Document, bytes: Uint8Array, name: string): void {
  const window = document.defaultView!;
  const url = window.URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  const anchor = document.createElement('a');
  anchor.download = name;
  anchor.href = url;
  anchor.hidden = true;
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url));
  }
}

class UploadStopped extends Error {}

interface IReplacePick extends IQuickPickItem {
  readonly id: 'replace' | 'skip';
}

/**
 * Writes files from the computer into a workspace folder (VS Code's `BrowserFileUpload`). Everything
 * that can be checked is checked before anything is written: only files, valid names, the size
 * limits, no folder in the way, and a question for each file that would replace one. Then the files
 * are written one by one, each in one write; the first failure stops the upload and says which
 * files were written before it.
 */
export class BrowserFileUpload {
  constructor(
    @IFileService private readonly fileService: IFileService,
    @IExplorerService private readonly explorer: IExplorerService,
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @IEditorService private readonly editorService: IEditorService,
  ) {}

  /** Uploads `entries` into `folder`; resolves to the files written. */
  async upload(folder: URI, entries: readonly IUploadEntry[]): Promise<URI[]> {
    if (!entries.length) {
      return [];
    }
    let plan: { readonly entry: IUploadEntry; readonly replace: boolean }[];
    try {
      plan = await this.prepare(folder, entries);
    } catch (error) {
      if (!(error instanceof UploadStopped)) {
        throw error;
      }
      if (error.message) {
        this.explorer.showError(error.message);
      }
      return [];
    }

    const written: URI[] = [];
    for (const { entry, replace } of plan) {
      const resource = joinPath(folder, entry.name);
      try {
        // The whole file is read before its one write: a file that cannot be read leaves nothing.
        const bytes = new Uint8Array(await entry.file!.arrayBuffer());
        if (bytes.byteLength > MAX_UPLOAD_FILE_SIZE) {
          throw new Error(`The file is larger than ${formatSize(MAX_UPLOAD_FILE_SIZE)}.`);
        }
        await (replace
          ? this.fileService.writeFile(resource, bytes)
          : this.fileService.createFile(resource, bytes, { overwrite: false }));
        written.push(resource);
      } catch (error) {
        console.warn(`Failed to upload ${resource}.`, error);
        const reason = `Unable to upload '${entry.name}': ${describeFileError(error)}`;
        this.explorer.showError(written.length
          ? `Uploaded ${written.length} of ${plan.length} files (${written.map(basename).join(', ')}), then stopped. ${reason}`
          : reason);
        break;
      }
    }
    await this.show(folder, written);
    return written;
  }

  /** What to write and whether it replaces a file, once every check and question has passed. */
  private async prepare(folder: URI, entries: readonly IUploadEntry[]) {
    const folders = entries.filter(entry => entry.isDirectory || !entry.file);
    if (folders.length) {
      throw new UploadStopped(`Unable to upload '${folders[0].name}': only files can be uploaded, not folders. Nothing was uploaded.`);
    }
    const names = new Set<string>();
    let total = 0;
    for (const entry of entries) {
      const invalid = validateFileName(entry.name);
      if (invalid) {
        throw new UploadStopped(`Unable to upload '${entry.name}': ${invalid} Nothing was uploaded.`);
      }
      if (names.has(entry.name)) {
        throw new UploadStopped(`Unable to upload: more than one file is named '${entry.name}'. Nothing was uploaded.`);
      }
      names.add(entry.name);
      if (entry.file!.size > MAX_UPLOAD_FILE_SIZE) {
        throw new UploadStopped(`Unable to upload '${entry.name}': it is larger than ${formatSize(MAX_UPLOAD_FILE_SIZE)}. Nothing was uploaded.`);
      }
      total += entry.file!.size;
    }
    if (total > MAX_UPLOAD_TOTAL_SIZE) {
      throw new UploadStopped(`Unable to upload: the files come to ${formatSize(total)}, more than the ${formatSize(MAX_UPLOAD_TOTAL_SIZE)} one upload takes. Nothing was uploaded.`);
    }

    let stat: IFileStat;
    try {
      stat = await this.fileService.resolve(folder);
    } catch (error) {
      throw new UploadStopped(`Unable to upload to '${basename(folder)}': ${describeFileError(error)}`);
    }
    if (!stat.isDirectory) {
      throw new UploadStopped(`Unable to upload to '${basename(folder)}': it is not a folder.`);
    }
    const existing = new Map((stat.children ?? []).map(child => [child.name, child]));

    const plan: { entry: IUploadEntry; replace: boolean }[] = [];
    for (const entry of entries) {
      const other = existing.get(entry.name);
      if (other?.isDirectory) {
        throw new UploadStopped(`Unable to upload '${entry.name}': a folder of that name is in '${stat.name}'. Nothing was uploaded.`);
      }
      plan.push({ entry, replace: !!other });
    }
    // Every question is answered before the first write: Escape leaves the folder as it was.
    const kept: IUploadEntry[] = [];
    for (const { entry, replace } of plan) {
      if (!replace) {
        continue;
      }
      const choice = await this.quickInput.pick<IReplacePick>([
        { id: 'replace', label: 'Replace', detail: 'This action is irreversible!' },
        { id: 'skip', label: 'Skip', detail: `Keep the existing '${entry.name}' and do not upload this file.` },
      ], { title: `A file named '${entry.name}' already exists in '${stat.name}'. Do you want to replace it?` });
      if (!choice) {
        this.explorer.focusView();
        throw new UploadStopped('');
      }
      if (choice.id === 'skip') {
        kept.push(entry);
      }
    }
    return plan.filter(({ entry }) => !kept.includes(entry));
  }

  /** Shows the written files: the folder read again, and the first file selected and opened, as VS Code does. */
  private async show(folder: URI, written: readonly URI[]): Promise<void> {
    const item = this.explorer.find(folder);
    if (item?.isResolved) {
      await this.explorer.resolveFolder(item);
    }
    const [first] = written;
    if (first) {
      await this.explorer.select(first);
      await this.editorService.openEditor({ resource: first });
    }
  }
}

/** Saves one workspace file to the computer, as it is stored (VS Code's `FileDownload`, without folders). */
export class FileDownload {
  constructor(
    @IFileService private readonly fileService: IFileService,
    @IExplorerService private readonly explorer: IExplorerService,
  ) {}

  async download(document: Document, resource: URI): Promise<boolean> {
    const name = basename(resource);
    try {
      const content = await this.fileService.readFile(resource);
      triggerDownload(document, content.value, name);
      return true;
    } catch (error) {
      console.warn(`Failed to download ${resource}.`, error);
      this.explorer.showError(`Unable to download '${name}': ${describeFileError(error)}`);
      return false;
    }
  }
}
