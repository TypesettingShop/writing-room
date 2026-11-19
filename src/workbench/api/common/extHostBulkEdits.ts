import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import { WorkspaceEdit } from './extHostTypes.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type { MainThreadBulkEditsShape, WorkspaceEditOperation } from './extHost.protocol.documents.js';
import type { ExtHostDocuments } from './extHostDocuments.js';

export class ExtHostBulkEdits {
  constructor(
    private readonly proxy: MainThreadBulkEditsShape,
    private readonly documents: ExtHostDocuments,
  ) {}

  async apply(extension: string, edit: vscode.WorkspaceEdit, metadata?: vscode.WorkspaceEditMetadata): Promise<boolean> {
    if (!(edit instanceof WorkspaceEdit)) {
      return false;
    }
    try {
      const operations = await Promise.all(edit.getOperations().map(async (entry): Promise<WorkspaceEditOperation> => {
        const uri = this.uri(entry.uri);
        switch (entry.kind) {
          case 'text': {
            const { range, newText, newEol } = entry.edit;
            return { kind: 'text', uri, version: this.documents.getByUri(entry.uri)?.version, edit: {
              operations: newEol === undefined ? [{ range: toModelRange(range), text: newText }] : [],
              eol: newEol,
            } };
          }
          case 'snippet':
            return {
              kind: 'text', uri, version: this.documents.getByUri(entry.uri)?.version,
              snippet: true, keepWhitespace: entry.edit.keepWhitespace === true,
              edit: { operations: [{ range: toModelRange(entry.edit.range), text: entry.edit.snippet.value }] },
            };
          case 'create': {
            const options = entry.options;
            const contents = options?.contents;
            return {
              kind: 'create', uri, overwrite: options?.overwrite, ignoreIfExists: options?.ignoreIfExists,
              contents: contents && (contents instanceof Uint8Array ? contents : await contents.data()),
            };
          }
          case 'rename':
            return {
              kind: 'rename', uri, target: this.uri(entry.newUri),
              overwrite: entry.options?.overwrite, ignoreIfExists: entry.options?.ignoreIfExists,
            };
          case 'delete':
            return { kind: 'delete', uri, recursive: entry.options?.recursive, ignoreIfNotExists: entry.options?.ignoreIfNotExists };
        }
      }));
      return await this.proxy.$applyWorkspaceEdit(extension, operations, metadata?.isRefactoring === true);
    } catch {
      return false;
    }
  }

  private uri(resource: vscode.Uri): URI {
    if (!URI.isUri(resource)) {
      throw new TypeError('Workspace edit requires a Uri.');
    }
    return resource;
  }
}
