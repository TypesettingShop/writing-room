import { DisposableStore } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';
import { isEqualOrParent } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IMonacoTextModel } from '../../../editor/browser/monaco.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { ITextModelService } from '../../../editor/common/services/resolverService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { configurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileService, toFileSystemProviderErrorCode } from '../../../platform/files/common/files.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import { ITextFileService } from '../../services/textfile/common/textfiles.js';
import type { DocumentEdit, MainThreadBulkEditsShape, WorkspaceEditOperation } from '../common/extHost.protocol.documents.js';
import { applyDocumentEdit, validateDocumentEdit } from './mainThreadDocumentEdits.js';
import { MainThreadDocuments } from './mainThreadDocuments.js';
import { MainThreadEditors } from './mainThreadEditors.js';

const refactoringAutoSave = 'files.refactoring.autoSave';
configurationRegistry.registerConfiguration({
  id: 'files',
  title: 'Files',
  properties: {
    [refactoringAutoSave]: {
      type: 'boolean',
      default: true,
      description: 'Saves files affected by a multi-resource refactoring automatically.',
    },
  },
});

type TextOperation = Extract<WorkspaceEditOperation, { kind: 'text' }>;
type Apply = () => Promise<void>;

interface FileState {
  readonly type: FileType;
  readonly origin: URI;
  readonly contents?: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Plain fallback for snippet tabstops, choices and placeholder defaults. */
function snippetText(snippet: string): string {
  let at = 0;
  const parse = (close: boolean, depth: number): string => {
    let text = '';
    while (at < snippet.length) {
      const char = snippet[at++];
      if (char === '}' && close) {
        return text;
      }
      if (char === '\\' && at < snippet.length && /[\\$}]/.test(snippet[at])) {
        text += snippet[at++];
      } else if (char === '$') {
        const bare = /^(?:\d+|[A-Z_]\w*)/.exec(snippet.slice(at));
        const braced = /^\{(?:\d+|[A-Z_]\w*)([}:|])/.exec(snippet.slice(at));
        if (bare) {
          at += bare[0].length;
        } else if (braced) {
          at += braced[0].length;
          if (braced[1] === ':' && depth < 100) {
            text += parse(true, depth + 1);
          } else if (braced[1] === '|') {
            const end = snippet.indexOf('|}', at);
            if (end !== -1) {
              text += snippet.slice(at, end).split(/(?<!\\),/, 1)[0].replace(/\\([,|\\])/g, '$1');
              at = end + 2;
            }
          }
        } else {
          text += char;
        }
      } else {
        text += char;
      }
    }
    return text;
  };
  return parse(false, 0);
}

function combinedEdits(entries: readonly TextOperation[], plain: boolean): DocumentEdit {
  return {
    operations: entries.flatMap(entry => entry.edit.operations.map(operation => ({
      ...operation,
      text: plain && entry.snippet && typeof operation.text === 'string' ? snippetText(operation.text) : operation.text,
    }))),
    eol: entries.filter(entry => entry.edit.eol !== undefined).at(-1)?.edit.eol,
  };
}

function editContents(contents: Uint8Array, edit: DocumentEdit): Uint8Array {
  const text = decoder.decode(contents);
  const separator = /\r\n|\r|\n/.exec(text)?.[0] === '\r\n' ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\r|\n/);
  const offsets = [0];
  for (const line of lines) {
    offsets.push(offsets.at(-1)! + line.length + separator.length);
  }
  const model = {
    getLineCount: () => lines.length,
    getLineContent: (line: number) => lines[line - 1],
    getOffsetAt: ({ lineNumber, column }: { lineNumber: number; column: number }) => offsets[lineNumber - 1] + column - 1,
  };
  const changes = validateDocumentEdit(model, edit).map(({ range, text: value }) => ({
    start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
    end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
    text: (value ?? '').replace(/\r\n|\r|\n/g, separator),
  })).sort((a, b) => a.start - b.start || a.end - b.end);
  const pieces: string[] = [];
  let offset = 0;
  const before = lines.join(separator);
  for (const change of changes) {
    pieces.push(before.slice(offset, change.start), change.text);
    offset = change.end;
  }
  pieces.push(before.slice(offset));
  const output = pieces.join('');
  return encoder.encode(edit.eol === undefined ? output : output.replace(/\r\n|\r|\n/g, edit.eol === 1 ? '\n' : '\r\n'));
}

export class MainThreadBulkEdits implements MainThreadBulkEditsShape {
  constructor(
    private readonly documents: MainThreadDocuments,
    private readonly editors: MainThreadEditors,
    @ITextModelService private readonly resolver: ITextModelService,
    @IEditorService private readonly editorService: IEditorService,
    @IFileService private readonly files: IFileService,
    @ITextFileService private readonly textFiles: ITextFileService,
    @IConfigurationService private readonly configuration: IConfigurationService,
  ) {}

  async $applyWorkspaceEdit(extension: string, operations: WorkspaceEditOperation[], isRefactoring?: boolean): Promise<boolean> {
    if (!Array.isArray(operations)) {
      return false;
    }
    const references = new DisposableStore();
    const versions = new Map<ITextModel, number>();
    const fileStates = new Map<string, FileState | null>();
    const writtenEtags = new Map<string, string>();
    const getFile = async (uri: URI): Promise<FileState | null> => {
      const key = uri.toString();
      if (fileStates.has(key)) {
        return fileStates.get(key)!;
      }
      try {
        const stat = await this.files.stat(uri);
        return { type: stat.isDirectory ? FileType.Directory : FileType.File, origin: uri };
      } catch (error) {
        if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
          throw error;
        }
        return null;
      }
    };
    const checkVersions = () => {
      for (const [model, expected] of versions) {
        if (model.isDisposed() || model.getVersionId() !== expected) {
          throw new Error('Workspace edit conflicts with a document change.');
        }
      }
    };

    try {
      const steps: Apply[] = [];
      const affected = new Set<string>();
      const saves = new Map<string, { uri: URI; model: ITextModel }>();
      const autoSave = isRefactoring === true && this.configuration.getValue(refactoringAutoSave) === true;
      const text = new Map<string, TextOperation[]>();
      const flush = async () => {
        if (!text.size) {
          return;
        }
        const edits: Array<() => void> = [];
        const writes: Apply[] = [];
        for (const entries of text.values()) {
          const uri = entries[0].uri;
          const key = uri.toString();
          affected.add(key);
          const state = fileStates.get(key);
          if (state === null || state?.type === FileType.Directory) {
            throw new Error('Workspace edit has no file at its target.');
          }
          // A newly created or moved file may have no model under its eventual URI yet.
          if (state && (state.contents || state.origin.toString() !== key)) {
            if (entries.some(entry => entry.version !== undefined)) {
              throw new Error('Workspace edit conflicts with a moved or replaced document.');
            }
            const bytes = state.contents ?? (await this.files.readFile(state.origin)).value;
            const edit = combinedEdits(entries, true);
            const contents = editContents(bytes, edit);
            fileStates.set(key, { ...state, contents });
            writes.push(async () => {
              const expected = writtenEtags.get(key);
              if (this.textFiles.canHandleResource(uri)) {
                if (expected !== undefined && (await this.files.stat(uri)).etag !== expected) {
                  throw new Error('The file changed after it was created or moved.');
                }
                const reference = references.add(await this.resolver.createModelReference(uri));
                const model = reference.object.textEditorModel as IMonacoTextModel;
                const alreadyEdited = versions.has(model);
                checkVersions();
                if (this.documents.isReadOnly(model) || (!alreadyEdited && this.textFiles.isDirty(uri))) {
                  throw new Error('The target acquired unsaved changes.');
                }
                const showing = this.editorService.findEditors(uri);
                if (showing.some(({ editor }) => editor.isReadonly())) {
                  throw new Error('The target editor is read-only.');
                }
                applyDocumentEdit(model, validateDocumentEdit(model, edit), edit.eol);
                versions.set(model, model.getVersionId());
                if (autoSave && !alreadyEdited && !showing.length) {
                  saves.set(key, { uri, model });
                }
                return;
              }
              // Until the text file service handles this scheme, a newly created file has no working copy.
              const { etag } = await this.files.writeFile(uri, contents, { etag: expected });
              writtenEtags.set(key, etag);
            });
            continue;
          }

          const reference = references.add(await this.resolver.createModelReference(uri));
          const model = reference.object.textEditorModel as IMonacoTextModel;
          const current = model.getVersionId();
          const showing = this.editorService.findEditors(uri);
          // An earlier text group of this edit changes the model before this one applies, so this
          // group's ranges cannot be checked against the text seen here, nor its version kept.
          const editedBefore = versions.has(model);
          if (this.documents.isReadOnly(model) || showing.some(({ editor }) => editor.isReadonly())
            || entries.some(entry => entry.version !== undefined && (editedBefore || current !== entry.version))) {
            throw new Error('Workspace edit conflicts with a document version or read-only resource.');
          }
          if (!editedBefore) {
            versions.set(model, current);
          }
          const active = this.editors.active;
          const snippet = !editedBefore && entries.length === 1 && entries[0].snippet && active?.model === model ? entries[0] : undefined;
          const edit = combinedEdits(entries, !snippet);
          const validated = validateDocumentEdit(model, edit);
          edits.push(() => {
            applyDocumentEdit(model, editedBefore ? validateDocumentEdit(model, edit) : validated, edit.eol);
            versions.set(model, model.getVersionId());
          });
          if (snippet && active) {
            // The active editor's snippet controller maintains tabstops. An inactive or mixed edit uses text.
            edits.pop();
            const { range, text: template } = validated[0];
            writes.unshift(async () => {
              checkVersions();
              if (this.editors.active !== active || !await this.editors.$insertSnippet(
                active.id, versions.get(model)!, template ?? '', [range], { keepWhitespace: snippet.keepWhitespace },
              )) {
                throw new Error('Workspace snippet target is unavailable.');
              }
              versions.set(model, model.getVersionId());
            });
          }
          // Saving a document that already had unsaved changes would write those changes too.
          if (autoSave && !editedBefore && uri.scheme !== Schemas.untitled && !showing.length && !this.textFiles.isDirty(uri)) {
            saves.set(key, { uri, model });
          }
        }
        text.clear();
        steps.push(async () => {
          checkVersions();
          for (const edit of edits) {
            edit();
          }
          for (const write of writes) {
            checkVersions();
            await write();
          }
        });
      };

      for (const operation of operations) {
        const { kind } = operation;
        const untitled = kind === 'text' && operation.uri?.scheme === Schemas.untitled;
        const uri = this.documents.authorizeResource(extension, operation.uri, !untitled);
        const key = uri.toString();
        if (kind === 'text') {
          if (!untitled) {
            await this.requireWritable(uri);
          }
          const entries = text.get(key) ?? [];
          entries.push({ ...operation, uri });
          text.set(key, entries);
          continue;
        }
        await flush();
        await this.requireWritable(uri);
        const existing = await getFile(uri);
        if (kind === 'create') {
          const overwrite = operation.overwrite === true;
          if (existing && !overwrite && operation.ignoreIfExists === true) {
            continue;
          }
          if ((existing && !overwrite) || existing?.type === FileType.Directory
            || (operation.contents !== undefined && !(operation.contents instanceof Uint8Array))) {
            return false;
          }
          const contents = operation.contents ?? new Uint8Array();
          affected.add(key);
          saves.delete(key);
          fileStates.set(key, { origin: uri, type: FileType.File, contents });
          steps.push(async () => {
            const { etag } = await this.files.createFile(uri, contents, { overwrite });
            writtenEtags.set(key, etag);
          });
        } else if (kind === 'rename') {
          const target = this.documents.authorizeResource(extension, operation.target, true);
          await this.requireWritable(target);
          const overwrite = operation.overwrite === true;
          const targetState = await getFile(target);
          if (!existing || isEqualOrParent(target, uri) || isEqualOrParent(uri, target)) {
            return false;
          }
          if (targetState && !overwrite && operation.ignoreIfExists === true) {
            continue;
          }
          if (targetState && !overwrite) {
            return false;
          }
          affected.add(target.toString());
          saves.delete(key);
          saves.delete(target.toString());
          fileStates.set(key, null);
          fileStates.set(target.toString(), existing);
          steps.push(async () => {
            const { etag } = await this.files.move(uri, target, overwrite);
            writtenEtags.delete(key);
            writtenEtags.set(target.toString(), etag);
          });
        } else if (kind === 'delete') {
          if (!existing && operation.ignoreIfNotExists === true) {
            continue;
          }
          if (!existing || (existing.type === FileType.Directory && operation.recursive !== true
            && (await this.files.resolve(existing.origin)).children?.length)) {
            return false;
          }
          affected.add(key);
          saves.delete(key);
          fileStates.set(key, null);
          steps.push(() => this.files.del(uri, { recursive: operation.recursive === true }));
        } else {
          return false;
        }
      }
      await flush();
      for (const step of steps) {
        checkVersions();
        await step();
      }
      if (affected.size > 1) {
        await Promise.allSettled([...saves.values()].map(async ({ uri, model }) => {
          if (!model.isDisposed() && model.getVersionId() === versions.get(model)) {
            await this.textFiles.save(uri);
          }
        }));
      }
      return true;
    } catch {
      return false;
    } finally {
      references.dispose();
    }
  }

  private async requireWritable(uri: URI): Promise<void> {
    await this.files.activateProvider(uri.scheme);
    const provider = this.files.getProvider(uri.scheme);
    if (!provider || provider.capabilities & FileSystemProviderCapabilities.Readonly) {
      throw new Error('Workspace edit requires a writable file system.');
    }
  }
}
