import type * as vscode from 'vscode';
import { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type { MarkerDataDto } from './extHost.protocol.diagnostics.js';
import type {
  CodeActionContextDto, CodeActionDto, CodeActionListDto, CodeActionProviderMetadataDto, ExtHostEditsShape, FormattingEditsDto,
  FormattingOptionsDto, RenameLocationDto, RenameResultDto,
} from './extHost.protocol.languageFeatures.js';
import { CodeActionKind } from './extHostCommonTypes.js';
import { fromMarkerData, toMarkerData } from './extHostDiagnosticTypes.js';
import { Selection } from './extHostEditorTypes.js';
import { isCommand, isRange, selectorToDto, textEditsToDto, workspaceEditToOperations } from './extHostLanguageConverters.js';
import type { ExtHostLanguageFeatures, LanguageFeatureGroup } from './extHostLanguageFeatures.js';
import { CodeAction, CodeActionTriggerKind } from './extHostLanguageFeatureTypes.js';
import { positionFromEditor, rangeFromEditor, rangeToEditor } from './extHostTypeConverters.js';
import type { EditorPosition, EditorRange, EditorSelection } from './extHostTypeConverters.js';

/*
 * Formatting (document, range, on type), code actions and rename on the extension host.
 *
 * Formatting edits go back with the version of the document the provider read; Monaco applies them
 * and the workbench drops them when the model moved on. The edits of code actions and renames are
 * workspace edits, which the extension host applies itself through the documents area's bulk edit,
 * each text operation at the version the document had when the provider was asked: an edit computed
 * for text that changed since is refused whole. A code action's command runs only after its edit was
 * applied. A code action list stays on the extension host under an id until the workbench releases it
 * (Monaco disposes it when the light bulb's actions are replaced or the editor goes).
 */

class DocumentFormattingAdapter {
  constructor(readonly provider: vscode.DocumentFormattingEditProvider) {}
}

class RangeFormattingAdapter {
  constructor(readonly provider: vscode.DocumentRangeFormattingEditProvider) {}
}

class OnTypeFormattingAdapter {
  constructor(readonly provider: vscode.OnTypeFormattingEditProvider) {}
}

/** Exported for `vscode.executeCodeActionProvider` (the navigation group). */
export class CodeActionAdapter {
  constructor(readonly provider: vscode.CodeActionProvider) {}
}

/** Exported for `vscode.executeDocumentRenameProvider` (the navigation group). */
export class RenameAdapter {
  constructor(readonly provider: vscode.RenameProvider) {}
}

/** Strings a provider gives as trigger characters; more are dropped. */
const MAX_TRIGGER_CHARACTERS = 64;
/** Markers handed to a code action provider, and actions of one list kept; more are dropped (as in VS Code). */
const MAX_DIAGNOSTICS = 1000;
const MAX_CODE_ACTIONS = 1000;
/** Ranges of one ranges formatting request. */
const MAX_RANGES = 1000;

interface CachedActions {
  readonly handle: number;
  readonly extension: HostExtensionDescription;
  /** The document the actions were asked for and its version then: their edits apply at that version only. */
  readonly uri: URI;
  readonly version: number;
  readonly items: (vscode.Command | vscode.CodeAction)[];
}

function checkProvider(provider: unknown, method: string): void {
  if (!provider || typeof (provider as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`The provider has no '${method}' function.`);
  }
}

/** The name Monaco shows for a formatter. */
function displayName(extension: HostExtensionDescription): string {
  const name = extension.manifest.displayName;
  return typeof name === 'string' && name ? name : extension.id;
}

function isPosition(position: EditorPosition): boolean {
  return !!position && Number.isSafeInteger(position.lineNumber) && Number.isSafeInteger(position.column)
    && position.lineNumber >= 1 && position.column >= 1;
}

/** The document's position of a workbench position; one that is not a position gives undefined. */
function documentPosition(document: vscode.TextDocument, position: EditorPosition): vscode.Position | undefined {
  return isPosition(position) ? document.validatePosition(positionFromEditor(position)) : undefined;
}

/** The document's range of a workbench range; one that is not a range gives undefined. */
function documentRange(document: vscode.TextDocument, range: EditorRange): vscode.Range | undefined {
  if (!range || !isPosition({ lineNumber: range.startLineNumber, column: range.startColumn })
    || !isPosition({ lineNumber: range.endLineNumber, column: range.endColumn })) {
    return undefined;
  }
  return document.validateRange(rangeFromEditor(range));
}

/** A selection (anchor and active end) when the workbench sent one, otherwise the range. */
function documentRangeOrSelection(document: vscode.TextDocument, value: EditorRange | EditorSelection): vscode.Range | undefined {
  const range = documentRange(document, value);
  if (!range) {
    return undefined;
  }
  const selection = value as Partial<EditorSelection>;
  const anchor = { lineNumber: selection.selectionStartLineNumber!, column: selection.selectionStartColumn! };
  const active = { lineNumber: selection.positionLineNumber!, column: selection.positionColumn! };
  if (!isPosition(anchor) || !isPosition(active)) {
    return range;
  }
  return new Selection(document.validatePosition(positionFromEditor(anchor)), document.validatePosition(positionFromEditor(active)));
}

function formattingOptions(dto: FormattingOptionsDto): vscode.FormattingOptions {
  return {
    tabSize: Number.isSafeInteger(dto?.tabSize) && dto.tabSize > 0 ? dto.tabSize : 4,
    insertSpaces: typeof dto?.insertSpaces === 'boolean' ? dto.insertSpaces : true,
  };
}

function triggerCharacters(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, MAX_TRIGGER_CHARACTERS);
}

/** The diagnostics of a code action context: the markers Monaco gave, with every field as it was. */
function contextDiagnostics(markers: readonly MarkerDataDto[] | undefined): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const marker of Array.isArray(markers) ? markers.slice(0, MAX_DIAGNOSTICS) : []) {
    try {
      diagnostics.push(fromMarkerData(marker));
    } catch {
      // A marker without a message or range is no diagnostic.
    }
  }
  return diagnostics;
}

function kindValue(kind: unknown): string | undefined {
  const value = kind && typeof kind === 'object' ? (kind as vscode.CodeActionKind).value : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** An action as it crosses; one without a title is dropped. */
function codeActionToDto(item: vscode.Command | vscode.CodeAction, index: number): CodeActionDto | undefined {
  if (isCommand(item)) {
    return { index, title: item.title };
  }
  if (!item || typeof item !== 'object' || typeof item.title !== 'string') {
    return undefined;
  }
  let diagnostics: MarkerDataDto[] | undefined;
  if (Array.isArray(item.diagnostics)) {
    diagnostics = [];
    for (const diagnostic of item.diagnostics.slice(0, MAX_DIAGNOSTICS)) {
      try {
        diagnostics.push(toMarkerData(diagnostic));
      } catch {
        // Not a diagnostic.
      }
    }
  }
  const reason = item.disabled && typeof item.disabled === 'object' ? item.disabled.reason : undefined;
  return {
    index,
    title: item.title,
    kind: kindValue(item.kind),
    isPreferred: item.isPreferred === true ? true : undefined,
    disabled: typeof reason === 'string' ? reason : undefined,
    diagnostics,
  };
}

/** What a provider's refusal says: the message of an `Error`, or a string; anything else says nothing. */
function rejection(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error;
  }
  return error instanceof Error && typeof error.message === 'string' ? error.message : undefined;
}

const sameUri = (a: URI, b: URI) => a.toString() === b.toString();

export class ExtHostEdits implements ExtHostEditsShape, LanguageFeatureGroup {
  private readonly lists = new Map<number, CachedActions>();
  private nextList = 0;

  readonly types = { CodeAction, CodeActionTriggerKind };

  constructor(private readonly features: ExtHostLanguageFeatures) {}

  /** The code action lists kept now, for tests that look for leaks. */
  get cacheSize(): number {
    return this.lists.size;
  }

  api(extension: HostExtensionDescription) {
    const { features } = this;
    return {
      registerDocumentFormattingEditProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentFormattingEditProvider) => {
        checkProvider(provider, 'provideDocumentFormattingEdits');
        const dto = selectorToDto(selector);
        return features.register(extension, new DocumentFormattingAdapter(provider), handle =>
          features.proxy.$registerDocumentFormattingSupport(extension.key, handle, dto, displayName(extension)));
      },
      registerDocumentRangeFormattingEditProvider: (selector: vscode.DocumentSelector, provider: vscode.DocumentRangeFormattingEditProvider) => {
        checkProvider(provider, 'provideDocumentRangeFormattingEdits');
        const dto = selectorToDto(selector);
        const supportsRanges = typeof provider.provideDocumentRangesFormattingEdits === 'function';
        return features.register(extension, new RangeFormattingAdapter(provider), handle =>
          features.proxy.$registerRangeFormattingSupport(extension.key, handle, dto, displayName(extension), supportsRanges));
      },
      registerOnTypeFormattingEditProvider: (selector: vscode.DocumentSelector, provider: vscode.OnTypeFormattingEditProvider,
        firstTriggerCharacter: string, ...moreTriggerCharacter: string[]) => {
        checkProvider(provider, 'provideOnTypeFormattingEdits');
        const dto = selectorToDto(selector);
        const triggers = triggerCharacters([firstTriggerCharacter, ...moreTriggerCharacter]);
        return features.register(extension, new OnTypeFormattingAdapter(provider), handle =>
          features.proxy.$registerOnTypeFormattingSupport(extension.key, handle, dto, triggers));
      },
      registerCodeActionsProvider: (selector: vscode.DocumentSelector, provider: vscode.CodeActionProvider, metadata?: vscode.CodeActionProviderMetadata) => {
        checkProvider(provider, 'provideCodeActions');
        const dto = selectorToDto(selector);
        // The documentation commands live as long as the registration.
        const commands = features.createCommandStore(extension);
        const metadataDto: CodeActionProviderMetadataDto = {
          providedCodeActionKinds: Array.isArray(metadata?.providedCodeActionKinds)
            ? metadata.providedCodeActionKinds.map(kindValue).filter((kind): kind is string => kind !== undefined) : undefined,
          documentation: Array.isArray(metadata?.documentation)
            ? metadata.documentation.flatMap(entry => {
              const kind = kindValue(entry?.kind);
              const command = commands.toDto(entry?.command);
              return kind !== undefined && command ? [{ kind, command }] : [];
            })
            : undefined,
        };
        const registration = features.register(extension, new CodeActionAdapter(provider), handle =>
          features.proxy.$registerCodeActionSupport(extension.key, handle, dto, metadataDto));
        return { dispose: () => {
          registration.dispose();
          commands.dispose();
        } } as vscode.Disposable;
      },
      registerRenameProvider: (selector: vscode.DocumentSelector, provider: vscode.RenameProvider) => {
        checkProvider(provider, 'provideRenameEdits');
        const dto = selectorToDto(selector);
        const supportsResolveLocation = typeof provider.prepareRename === 'function';
        return features.register(extension, new RenameAdapter(provider), handle =>
          features.proxy.$registerRenameSupport(extension.key, handle, dto, supportsResolveLocation));
      },
    } satisfies Pick<typeof vscode.languages, 'registerDocumentFormattingEditProvider' | 'registerDocumentRangeFormattingEditProvider'
      | 'registerOnTypeFormattingEditProvider' | 'registerCodeActionsProvider' | 'registerRenameProvider'>;
  }

  // --- Formatting --------------------------------------------------------------------------------

  /**
   * Asks a formatter: `call` gives the provider's answer, or undefined without asking when the
   * workbench's arguments do not fit the document. The edits go back with the version the provider read.
   */
  private format<A>(
    handle: number, kind: abstract new (...args: any[]) => A, uri: URI, token: CancellationToken,
    call: (adapter: A, document: vscode.TextDocument) => vscode.ProviderResult<vscode.TextEdit[]>,
  ): Promise<FormattingEditsDto | undefined> {
    return this.features.invoke(handle, kind, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      if (!document) {
        return undefined;
      }
      const version = document.version;
      const edits = textEditsToDto(await call(adapter, document));
      return edits && !token.isCancellationRequested ? { version, edits } : undefined;
    });
  }

  $provideDocumentFormattingEdits(handle: number, uri: URI, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined> {
    return this.format(handle, DocumentFormattingAdapter, uri, token, (adapter, document) =>
      adapter.provider.provideDocumentFormattingEdits(document, formattingOptions(options), token as vscode.CancellationToken));
  }

  $provideDocumentRangeFormattingEdits(handle: number, uri: URI, range: EditorRange, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined> {
    return this.format(handle, RangeFormattingAdapter, uri, token, (adapter, document) => {
      const at = documentRange(document, range);
      return at && adapter.provider.provideDocumentRangeFormattingEdits(document, at, formattingOptions(options), token as vscode.CancellationToken);
    });
  }

  $provideDocumentRangesFormattingEdits(handle: number, uri: URI, ranges: readonly EditorRange[], options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined> {
    return this.format(handle, RangeFormattingAdapter, uri, token, (adapter, document) => {
      if (typeof adapter.provider.provideDocumentRangesFormattingEdits !== 'function' || !Array.isArray(ranges)) {
        return undefined;
      }
      const at = ranges.slice(0, MAX_RANGES).map(range => documentRange(document, range));
      return at.every(range => !!range)
        ? adapter.provider.provideDocumentRangesFormattingEdits(document, at as vscode.Range[], formattingOptions(options), token as vscode.CancellationToken)
        : undefined;
    });
  }

  $provideOnTypeFormattingEdits(handle: number, uri: URI, position: EditorPosition, character: string, options: FormattingOptionsDto, token: CancellationToken): Promise<FormattingEditsDto | undefined> {
    return this.format(handle, OnTypeFormattingAdapter, uri, token, (adapter, document) => {
      const at = documentPosition(document, position);
      return at && typeof character === 'string'
        ? adapter.provider.provideOnTypeFormattingEdits(document, at, character, formattingOptions(options), token as vscode.CancellationToken)
        : undefined;
    });
  }

  // --- Code actions ------------------------------------------------------------------------------

  async $provideCodeActions(handle: number, uri: URI, rangeOrSelection: EditorRange | EditorSelection, context: CodeActionContextDto, token: CancellationToken): Promise<CodeActionListDto | undefined> {
    let built: { list: CachedActions; dto: CodeActionListDto } | undefined;
    const result = await this.features.invoke(handle, CodeActionAdapter, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      const range = document && documentRangeOrSelection(document, rangeOrSelection);
      if (!document || !range) {
        return undefined;
      }
      const version = document.version;
      const only = typeof context?.only === 'string' && context.only ? CodeActionKind.Empty.append(context.only) : undefined;
      const value = await adapter.provider.provideCodeActions(document, range, {
        diagnostics: contextDiagnostics(context?.markers),
        only,
        triggerKind: context?.trigger === CodeActionTriggerKind.Automatic ? CodeActionTriggerKind.Automatic : CodeActionTriggerKind.Invoke,
      }, token as vscode.CancellationToken);
      if (!Array.isArray(value) || !value.length || token.isCancellationRequested) {
        return undefined;
      }
      const items = value.slice(0, MAX_CODE_ACTIONS);
      const actions: CodeActionDto[] = [];
      items.forEach((item, index) => {
        const dto = codeActionToDto(item, index);
        if (dto) {
          actions.push(dto);
        }
      });
      if (only && actions.some(action => action.kind === undefined ? !isCommand(items[action.index]) : !only.contains(CodeActionKind.Empty.append(action.kind)))) {
        // As in VS Code: said, not enforced; Monaco filters them out.
        console.warn(`[${extension.id}] Code actions of kind '${only.value}' were asked for, but some returned actions have no kind or another kind.`);
      }
      if (!actions.length) {
        return undefined;
      }
      const id = ++this.nextList;
      built = { list: { handle, extension, uri, version, items }, dto: { id, actions } };
      return built.dto;
    });
    if (!result || !built || built.dto !== result || token.isCancellationRequested) {
      return undefined;
    }
    this.lists.set(result.id, built.list);
    return result;
  }

  async $applyCodeAction(handle: number, id: number, index: number): Promise<boolean | undefined> {
    const list = this.lists.get(id);
    const found = this.features.adapter(handle, CodeActionAdapter);
    let item = list?.handle === handle && Number.isSafeInteger(index) ? list.items[index] : undefined;
    if (!list || !item || !found) {
      return undefined;
    }
    const { adapter, extension } = found;
    if (!isCommand(item) && !item.edit && typeof adapter.provider.resolveCodeAction === 'function') {
      try {
        const resolved = await adapter.provider.resolveCodeAction(item, CancellationToken.None);
        if (resolved && typeof resolved === 'object') {
          item = resolved;
          list.items[index] = resolved;
        }
      } catch (error) {
        console.error(`[${extension.id}] Resolving a code action failed:`, error);
      }
    }
    const command = isCommand(item) ? item : item.command;
    if (!isCommand(item) && item.edit && !await this.applyEdit(handle, extension, item.edit, list.uri, list.version)) {
      return false;
    }
    if (isCommand(command)) {
      // A throw reaches the workbench, which shows its message as VS Code does.
      await this.features.commands.executeCommand(extension.key, command.command, Array.isArray(command.arguments) ? command.arguments : []);
    }
    return true;
  }

  async $releaseCodeActions(handle: number, id: number): Promise<void> {
    if (this.lists.get(id)?.handle === handle) {
      this.lists.delete(id);
    }
  }

  async $codeActionCacheSize(): Promise<number> {
    return this.lists.size;
  }

  // --- Rename ------------------------------------------------------------------------------------

  $resolveRenameLocation(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<RenameLocationDto | undefined> {
    return this.features.invoke(handle, RenameAdapter, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      const at = document && documentPosition(document, position);
      if (!document || !at || typeof adapter.provider.prepareRename !== 'function') {
        return undefined;
      }
      let value: Awaited<ReturnType<NonNullable<vscode.RenameProvider['prepareRename']>>>;
      try {
        value = await adapter.provider.prepareRename(document, at, token as vscode.CancellationToken);
      } catch (error) {
        // A provider refuses by throwing; its message is what the user sees.
        const reason = rejection(error);
        if (reason === undefined) {
          throw error;
        }
        return { rejectReason: reason };
      }
      let range: vscode.Range | undefined;
      let text: unknown;
      if (isRange(value)) {
        range = value;
        text = document.getText(value);
      } else if (value && typeof value === 'object' && isRange(value.range)) {
        range = value.range;
        text = value.placeholder;
      }
      if (!range || typeof text !== 'string' || !text) {
        return undefined;
      }
      if (range.start.line > at.line || range.end.line < at.line) {
        console.warn(`[${extension.id}] The rename location must contain the position's line; it is ignored.`);
        return undefined;
      }
      return { range: rangeToEditor(range), text };
    });
  }

  $provideRenameEdits(handle: number, uri: URI, position: EditorPosition, newName: string, token: CancellationToken): Promise<RenameResultDto | undefined> {
    return this.features.invoke(handle, RenameAdapter, token, undefined, async (adapter, extension): Promise<RenameResultDto | undefined> => {
      const document = this.features.document(extension, uri);
      const at = document && documentPosition(document, position);
      if (!document || !at || typeof newName !== 'string') {
        return undefined;
      }
      const version = document.version;
      let edit: vscode.WorkspaceEdit | null | undefined;
      try {
        edit = await adapter.provider.provideRenameEdits(document, at, newName, token as vscode.CancellationToken);
      } catch (error) {
        const reason = rejection(error);
        if (reason === undefined) {
          throw error;
        }
        return { rejectReason: reason };
      }
      if (!edit || token.isCancellationRequested) {
        return undefined;
      }
      return await this.applyEdit(handle, extension, edit, uri, version, token)
        ? { applied: true }
        : { rejectReason: 'The rename could not be applied: a document changed or cannot be edited.' };
    });
  }

  /**
   * Applies a provider's workspace edit through the bulk edit, as a refactoring (several files are
   * saved after it, as VS Code does with code actions and renames). The document the provider was asked
   * about must still be at `version`; another open document at the version the extension host knows now.
   */
  private async applyEdit(
    handle: number, extension: HostExtensionDescription, edit: vscode.WorkspaceEdit, uri: URI, version: number, token?: CancellationToken,
  ): Promise<boolean> {
    let operations;
    try {
      operations = await workspaceEditToOperations(edit, target => sameUri(target, uri) ? version : this.features.version(target));
    } catch (error) {
      console.error(`[${extension.id}] A workspace edit could not be read:`, error);
      return false;
    }
    // Not when the request was cancelled meanwhile, nor once the provider is gone.
    if (token?.isCancellationRequested || !this.features.adapter(handle, Object)) {
      return false;
    }
    return this.features.bulkEdits.$applyWorkspaceEdit(extension.key, operations, true).catch(() => false);
  }

  /** Forgets the lists of an extension that was released. */
  release(key: string): void {
    for (const [id, list] of [...this.lists]) {
      if (list.extension.key === key) {
        this.lists.delete(id);
      }
    }
  }

  dispose(): void {
    this.lists.clear();
  }
}

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createEditsGroup(features: ExtHostLanguageFeatures): ExtHostEdits {
  return new ExtHostEdits(features);
}
