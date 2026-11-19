import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import {
  BrowserFileUpload, chooseFilesToUpload, MAX_UPLOAD_FILE_SIZE, MAX_UPLOAD_TOTAL_SIZE, triggerDownload,
} from '../../browser/fileImportExport.js';
import type { IUploadEntry } from '../../browser/fileImportExport.js';

const root = URI.from({ scheme: 'vscode-vfs', authority: 'writing-room', path: '/workspace' });
const file = (path: string) => URI.joinPath(root, path);

const disposables = new DisposableStore();
let files: FileService;
let errors: string[];
let questions: string[];
/** The answers the quick pick gives, in turn: an item id, or `undefined` for Escape. */
let answers: (string | undefined)[];
let opened: URI[];

function createUpload(): BrowserFileUpload {
  const explorer = {
    showError: (message: string) => errors.push(message),
    focusView: () => {},
    find: () => undefined,
    resolveFolder: async () => {},
    select: async () => true,
  };
  const quickInput = {
    pick: async <T extends IQuickPickItem>(items: readonly T[], options?: { title?: string }) => {
      questions.push(options?.title ?? '');
      const id = answers.shift();
      return items.find(item => item.id === id);
    },
  };
  const editors = { openEditor: async (input: { resource: URI }) => { opened.push(input.resource); } };
  return new BrowserFileUpload(files, explorer as never, quickInput as never, editors as never);
}

/** A file to upload with `text` as its bytes, or a stand-in of `size` bytes that must never be read. */
function entry(name: string, content: string | { size: number }): IUploadEntry & { read: ReturnType<typeof vi.fn> } {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : undefined;
  const read = vi.fn(async () => {
    if (!bytes) {
      throw new Error('This file must not be read.');
    }
    return bytes.buffer;
  });
  return { name, isDirectory: false, file: { size: bytes?.byteLength ?? (content as { size: number }).size, arrayBuffer: read }, read };
}

async function text(path: string): Promise<string | undefined> {
  return await files.exists(file(path)) ? new TextDecoder().decode((await files.readFile(file(path))).value) : undefined;
}

async function names(): Promise<string[]> {
  return ((await files.resolve(root)).children ?? []).map(child => child.name).sort();
}

beforeEach(async () => {
  files = disposables.add(new FileService());
  files.registerProvider('vscode-vfs', disposables.add(new InMemoryFileSystemProvider()));
  await files.createFolder(root);
  errors = [];
  questions = [];
  answers = [];
  opened = [];
});

afterEach(() => {
  disposables.clear();
  vi.restoreAllMocks();
});

describe('BrowserFileUpload', () => {
  test('writes the files with their bytes and opens the first', async () => {
    const binary = { name: 'data.bin', isDirectory: false, file: new Blob([new Uint8Array([0, 255, 128, 10])]) };
    const written = await createUpload().upload(root, [entry('a.md', '# A'), binary]);
    expect(written.map(String)).toEqual([file('a.md').toString(), file('data.bin').toString()]);
    expect(await text('a.md')).toBe('# A');
    expect(Array.from((await files.readFile(file('data.bin'))).value)).toEqual([0, 255, 128, 10]);
    expect(opened.map(String)).toEqual([file('a.md').toString()]);
    expect(errors).toEqual([]);
  });

  test('a file over 50 MiB writes nothing, not even the files before it, and reads none', async () => {
    const small = entry('small.md', 'small');
    const big = entry('big.bin', { size: MAX_UPLOAD_FILE_SIZE + 1 });
    await createUpload().upload(root, [small, big]);
    expect(await names()).toEqual([]);
    expect(small.read).not.toHaveBeenCalled();
    expect(big.read).not.toHaveBeenCalled();
    expect(errors).toEqual(["Unable to upload 'big.bin': it is larger than 50 MB. Nothing was uploaded."]);

    // Exactly the limit is taken.
    const edge = entry('edge.bin', { size: MAX_UPLOAD_FILE_SIZE });
    edge.read.mockResolvedValueOnce(new ArrayBuffer(0));
    errors = [];
    await createUpload().upload(root, [edge]);
    expect(edge.read).toHaveBeenCalled();
    expect(await names()).toEqual(['edge.bin']);
    expect(errors).toEqual([]);
  });

  test('files over 200 MiB together write nothing', async () => {
    const parts = [1, 2, 3, 4].map(index => entry(`part${index}.bin`, { size: MAX_UPLOAD_TOTAL_SIZE / 4 }));
    const extra = entry('extra.md', 'x');
    await createUpload().upload(root, [extra, ...parts]);
    expect(await names()).toEqual([]);
    expect(extra.read).not.toHaveBeenCalled();
    expect(errors).toEqual(['Unable to upload: the files come to 200.0 MB, more than the 200 MB one upload takes. Nothing was uploaded.']);
  });

  test('a folder, a name with a path separator or a name twice writes nothing', async () => {
    await createUpload().upload(root, [entry('ok.md', 'ok'), { name: 'photos', isDirectory: true }]);
    await createUpload().upload(root, [entry('ok.md', 'ok'), entry('a/b.md', 'b')]);
    await createUpload().upload(root, [entry('ok.md', 'ok'), entry('a\\b.md', 'b')]);
    await createUpload().upload(root, [entry('ok.md', 'ok'), entry('..', 'b')]);
    await createUpload().upload(root, [entry('ok.md', 'ok'), entry('ok.md', 'again')]);
    expect(await names()).toEqual([]);
    expect(errors).toHaveLength(5);
    expect(errors[0]).toBe("Unable to upload 'photos': only files can be uploaded, not folders. Nothing was uploaded.");
    expect(errors[1]).toMatch(/^Unable to upload 'a\/b.md': This name is not valid/);
    expect(errors[2]).toMatch(/^Unable to upload 'a\\b.md': This name is not valid/);
    expect(errors[3]).toMatch(/^Unable to upload '..': This name is not valid/);
    expect(errors[4]).toBe("Unable to upload: more than one file is named 'ok.md'. Nothing was uploaded.");
  });

  test('asks before replacing a file; Escape writes nothing, Skip keeps it, Replace replaces it', async () => {
    await files.writeFile(file('same.md'), new TextEncoder().encode('old'));
    const title = "A file named 'same.md' already exists in 'workspace'. Do you want to replace it?";

    answers = [undefined];
    await createUpload().upload(root, [entry('new.md', 'new'), entry('same.md', 'replaced')]);
    expect(questions).toEqual([title]);
    expect(await names()).toEqual(['same.md']);
    expect(await text('same.md')).toBe('old');

    answers = ['skip'];
    await createUpload().upload(root, [entry('new.md', 'new'), entry('same.md', 'replaced')]);
    expect(await names()).toEqual(['new.md', 'same.md']);
    expect(await text('same.md')).toBe('old');

    answers = ['replace'];
    await createUpload().upload(root, [entry('same.md', 'replaced')]);
    expect(questions).toHaveLength(3);
    expect(await text('same.md')).toBe('replaced');
    expect(errors).toEqual([]);
  });

  test('a folder of the same name is never replaced', async () => {
    await files.createFolder(file('notes'));
    await createUpload().upload(root, [entry('a.md', 'a'), entry('notes', 'file')]);
    expect(questions).toEqual([]);
    expect(await names()).toEqual(['notes']);
    expect((await files.stat(file('notes'))).isDirectory).toBe(true);
    expect(errors).toEqual(["Unable to upload 'notes': a folder of that name is in 'workspace'. Nothing was uploaded."]);
  });

  test('a file that cannot be read stops the upload: the files before it stay and are named, none after it is written', async () => {
    const broken = entry('broken.md', 'x');
    broken.read.mockRejectedValueOnce(new Error('The file changed on the disk.'));
    const after = entry('after.md', 'after');
    await createUpload().upload(root, [entry('one.md', '1'), entry('two.md', '2'), broken, after]);
    expect(await names()).toEqual(['one.md', 'two.md']);
    expect(after.read).not.toHaveBeenCalled();
    expect(errors).toEqual([
      "Uploaded 2 of 4 files (one.md, two.md), then stopped. Unable to upload 'broken.md': The file changed on the disk.",
    ]);
  });

  test('a write that fails (the storage is full) leaves no part of that file and stops', async () => {
    const realCreate = files.createFile.bind(files);
    vi.spyOn(files, 'createFile').mockImplementation(async (resource, content, options) => {
      if (resource.path.endsWith('/full.md')) {
        throw Object.assign(new Error('Quota exceeded'), { name: 'QuotaExceededError' });
      }
      return realCreate(resource, content, options);
    });
    await createUpload().upload(root, [entry('first.md', '1'), entry('full.md', 'x'.repeat(1000)), entry('last.md', '3')]);
    expect(await names()).toEqual(['first.md']);
    expect(errors).toEqual([
      "Uploaded 1 of 3 files (first.md), then stopped. Unable to upload 'full.md': The browser storage is full. Free up space and try again.",
    ]);
  });

  test('a file that appears meanwhile under a new name is not replaced without asking', async () => {
    const late = entry('late.md', 'mine');
    late.read.mockImplementationOnce(async () => {
      // Another tab writes the same name after the question round, before this write.
      await files.writeFile(file('late.md'), new TextEncoder().encode('theirs'));
      return new TextEncoder().encode('mine').buffer;
    });
    await createUpload().upload(root, [late]);
    expect(await text('late.md')).toBe('theirs');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^Unable to upload 'late.md': /);
  });
});

describe('file chooser and download', () => {
  test('the chooser resolves to the chosen files, or to nothing when cancelled, and leaves no input behind', async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      this.dispatchEvent(new Event('cancel'));
    });
    await expect(chooseFilesToUpload(document)).resolves.toBeUndefined();
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  test('a download clicks a link to a Blob URL named after the file and lets the URL go afterwards', async () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const clicks: { download: string; href: string; attached: boolean }[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      created.push(blob as Blob);
      return 'blob:test/1';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => { revoked.push(url); });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ download: this.download, href: this.getAttribute('href') ?? '', attached: this.isConnected });
      // The URL is still good while the browser takes it.
      expect(revoked).toEqual([]);
    });
    triggerDownload(document, new Uint8Array([1, 2, 3]), 'notes.md');
    expect(clicks).toEqual([{ download: 'notes.md', href: 'blob:test/1', attached: true }]);
    expect(Array.from(new Uint8Array(await created[0].arrayBuffer()))).toEqual([1, 2, 3]);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    await vi.waitFor(() => expect(revoked).toEqual(['blob:test/1']));
  });
});
