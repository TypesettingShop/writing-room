import { URI } from '../../src/base/common/uri.js';
import { FileChangeType, FileOperationError, FileOperationResult } from '../../src/platform/files/common/files.js';
import { BrowserFileService } from '../../src/workbench/services/workspaces/browser/browserFileService.js';

const files = new BrowserFileService();
const root = URI.parse('vscode-vfs://writing-room/workspace');
const uri = (path: string) => URI.joinPath(root, path);
const events: string[] = [];
files.onDidFilesChange(event => {
  for (const { resource, type } of event.changes) {
    events.push(FileChangeType[type] + ':' + resource.path);
  }
});

const api = {
  events,
  async mkdir(path: string) { await files.createFolder(uri(path)); },
  async write(path: string, content: string, etag?: string): Promise<string> {
    try {
      await files.writeFile(uri(path), new TextEncoder().encode(content), { etag });
      return 'saved';
    } catch (error) {
      if (error instanceof FileOperationError) {
        return FileOperationResult[error.fileOperationResult];
      }
      throw error;
    }
  },
  async read(path: string) {
    const result = await files.readFile(uri(path));
    return { text: new TextDecoder().decode(result.value), etag: result.etag };
  },
  async list(path: string) {
    return (await files.resolve(uri(path))).children?.map(child => child.name);
  },
};

declare global {
  interface Window {
    filesHarness: typeof api;
  }
}

await files.createFolder(root);
window.filesHarness = api;
document.querySelector('#status')!.textContent = 'Ready';
window.addEventListener('pagehide', () => files.dispose(), { once: true });
