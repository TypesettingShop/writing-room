import { KeyChord, KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../editor/browser/monaco.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../editor/common/editorContextKeys.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../services/editor/common/editorService.js';
import type { MarkerDataDto } from '../common/extHost.protocol.diagnostics.js';
import type {
  CodeActionDto, CodeActionListDto, CodeActionProviderMetadataDto, FormattingEditsDto, FormattingOptionsDto, MainThreadEditsShape,
  RenameLocationDto, RenameResultDto,
} from '../common/extHost.protocol.languageFeatures.js';
import type { EditorPosition, EditorRange, EditorSelection } from '../common/extHostTypeConverters.js';
import { sanitizeMarker } from './mainThreadDiagnostics.js';
import { paneControl } from './mainThreadEditors.js';
import { checkSelector, request } from './mainThreadLanguageFeatures.js';
import type { MainThreadLanguageFeatures } from './mainThreadLanguageFeatures.js';
import { checkRange } from './mainThreadLanguageFeaturesCompletions.js';

/*
 * Formatting, code actions and rename on the workbench side: Monaco providers that ask the extension
 * host. Nothing the host sends reaches Monaco unchecked.
 *
 * - Formatting: Monaco applies the edits itself, only when the model is still at the version it had
 *   when it asked and the extension host read (a slow formatter's edits after typing are dropped whole).
 * - Code actions: Monaco never gets an edit. Each action's command asks the extension host to apply the
 *   action, which goes through the bulk edit of the documents area (permissions, read-only editors,
 *   files that are not open) and runs the action's command after it. A list Monaco disposes is released
 *   on the extension host.
 * - Rename: the extension host applies the edit itself; Monaco gets an empty edit, or the reason the
 *   rename was refused.
 */

// The workbench captures Ctrl+K for its own chords before Monaco can see it. This command also hides the
// `editor.action.*` bridge of apiCommands.ts that extensions run, so it keeps that bridge's behavior: the
// active pane's editor when no editor has focus, the caller's argument, and an error when there is none.
const formatSelectionId = 'editor.action.formatSelection';
KeybindingsRegistry.registerCommandAndKeybindingRule({
  id: formatSelectionId,
  weight: KeybindingWeight.EditorContrib,
  primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyF),
  when: ContextKeyExpr.and(EditorContextKeys.editorTextFocus.isEqualTo(true), EditorContextKeys.readOnly.toNegated()),
  handler: async (accessor, ...args: unknown[]) => {
    const focused = accessor.get(ICodeEditorService).getFocusedCodeEditor();
    const pane = accessor.get(IEditorService).activeEditorPane;
    const control = focused?.getModel() ? focused : paneControl(pane);
    const action = control?.getModel() ? control.getAction(formatSelectionId) : null;
    if (!action) {
      throw new Error(`command '${formatSelectionId}' not found`);
    }
    // Monaco's action does nothing when its precondition (a range formatter, a writable model) fails.
    await action.run(args[0]);
  },
});

type Languages = MonacoNamespace['languages'];
type DocumentFormattingProvider = Parameters<Languages['registerDocumentFormattingEditProvider']>[1];
type RangeFormattingProvider = Parameters<Languages['registerDocumentRangeFormattingEditProvider']>[1];
type OnTypeFormattingProvider = Parameters<Languages['registerOnTypeFormattingEditProvider']>[1];
type CodeActionProvider = Parameters<Languages['registerCodeActionProvider']>[1];
type CodeActionMetadata = NonNullable<Parameters<Languages['registerCodeActionProvider']>[2]>;
type RenameProvider = Parameters<Languages['registerRenameProvider']>[1];
type MonacoFormattingOptions = Parameters<DocumentFormattingProvider['provideDocumentFormattingEdits']>[1];
type MonacoTextEdit = NonNullable<Awaited<ReturnType<DocumentFormattingProvider['provideDocumentFormattingEdits']>>>[number];
type MonacoCodeActionContext = Parameters<CodeActionProvider['provideCodeActions']>[2];
type MonacoCodeActionList = NonNullable<Awaited<ReturnType<CodeActionProvider['provideCodeActions']>>>;
type MonacoCodeAction = MonacoCodeActionList['actions'][number];
type MonacoRenameEdits = NonNullable<Awaited<ReturnType<RenameProvider['provideRenameEdits']>>>;
type MonacoRenameLocation = NonNullable<Awaited<ReturnType<NonNullable<RenameProvider['resolveRenameLocation']>>>>;
type MonacoPosition = Parameters<RenameProvider['provideRenameEdits']>[1];
type MonacoToken = Parameters<RenameProvider['provideRenameEdits']>[3];

/** Monaco's token as the RPC takes it: the RPC forwards its cancellation to the extension host. */
const rpcToken = (token: MonacoToken) => token as unknown as CancellationToken;

/** Longest title, kind, reason or name kept; the rest is cut. */
const MAX_TEXT = 10 * 1024;
/** Longest edit text kept. */
const MAX_EDIT_TEXT = 1024 * 1024;
const MAX_EDITS = 100_000;
const MAX_CODE_ACTIONS = 1000;
const MAX_MARKERS = 1000;
const MAX_KINDS = 256;
const MAX_CHARACTERS = 64;
const MAX_RANGES = 1000;
/** Monaco's `EndOfLineSequence`: LF 0, CRLF 1. */
const END_OF_LINE = new Set([0, 1]);
/** Monaco's `CodeActionTriggerType`: Invoke 1, Auto 2. */
const CODE_ACTION_TRIGGERS = new Set([1, 2]);

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length <= max) {
    return value;
  }
  const end = /[\uD800-\uDBFF]/.test(value[max - 1]) ? max - 1 : max;
  return value.slice(0, end) + '…';
}

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_TEXT).slice(0, max)
    : [];
}

const isIndex = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function formattingOptions(options: MonacoFormattingOptions): FormattingOptionsDto {
  return {
    tabSize: Number.isSafeInteger(options?.tabSize) && options.tabSize > 0 ? options.tabSize : 4,
    insertSpaces: typeof options?.insertSpaces === 'boolean' ? options.insertSpaces : true,
  };
}

/** Formatting edits as Monaco applies them; an entry of another shape is dropped. */
export function checkTextEdits(value: unknown): MonacoTextEdit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const edits: MonacoTextEdit[] = [];
  for (const edit of value.slice(0, MAX_EDITS)) {
    const range = checkRange(edit?.range);
    // Cutting an edit's text would put broken text in the document: one that is too long is dropped.
    const editText = typeof edit?.text === 'string' && edit.text.length <= MAX_EDIT_TEXT ? edit.text as string : undefined;
    if (range && editText !== undefined) {
      edits.push(END_OF_LINE.has(edit.eol) ? { range, text: editText, eol: edit.eol } : { range, text: editText });
    }
  }
  return edits;
}

/** A range or a selection of Monaco's, as it crosses: a selection keeps its anchor and active end. */
function rangeOrSelection(value: EditorRange & Partial<EditorSelection>): EditorRange | EditorSelection {
  const range: EditorRange = {
    startLineNumber: value.startLineNumber, startColumn: value.startColumn, endLineNumber: value.endLineNumber, endColumn: value.endColumn,
  };
  return typeof value.selectionStartLineNumber === 'number' && typeof value.positionLineNumber === 'number' ? {
    ...range,
    selectionStartLineNumber: value.selectionStartLineNumber, selectionStartColumn: value.selectionStartColumn!,
    positionLineNumber: value.positionLineNumber, positionColumn: value.positionColumn!,
  } : range;
}

/** Markers as plain values with workbench URIs, checked as the diagnostics area checks markers. */
function markers(value: unknown): MarkerDataDto[] {
  return Array.isArray(value)
    ? value.slice(0, MAX_MARKERS).map(sanitizeMarker).filter((marker): marker is MarkerDataDto => !!marker)
    : [];
}

function position(value: MonacoPosition): EditorPosition {
  return { lineNumber: value.lineNumber, column: value.column };
}

export class MainThreadEdits implements MainThreadEditsShape, IDisposable {
  constructor(private readonly seam: MainThreadLanguageFeatures) {
    liveGroups.add(this);
  }

  /** How many code action lists the extension host keeps now. */
  cacheSize(): Promise<number> {
    return this.seam.proxy.$codeActionCacheSize();
  }

  // --- Formatting --------------------------------------------------------------------------------

  /**
   * Asks for formatting edits. They go to Monaco only when the extension host computed them for the
   * version the model had when Monaco asked, and the model is still at it: edits for other text would
   * break the document.
   */
  private async format(model: IMonacoTextModel, token: MonacoToken, call: (resource: URI) => Promise<FormattingEditsDto | undefined>): Promise<MonacoTextEdit[] | undefined> {
    const version = model.getVersionId();
    const dto = await request(model, token, call);
    if (!dto || typeof dto !== 'object' || dto.version !== version || model.isDisposed() || model.getVersionId() !== version) {
      return undefined;
    }
    return checkTextEdits(dto.edits);
  }

  $registerDocumentFormattingSupport(extension: string, handle: number, selector: unknown, displayName: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const name = text(displayName);
    return this.seam.register(extension, handle, monaco => {
      const provider: DocumentFormattingProvider = {
        displayName: name,
        provideDocumentFormattingEdits: (model, options, token) => this.format(model, token, uri =>
          this.seam.proxy.$provideDocumentFormattingEdits(handle, uri, formattingOptions(options), rpcToken(token))),
      };
      return monaco.languages.registerDocumentFormattingEditProvider(checked as Parameters<Languages['registerDocumentFormattingEditProvider']>[0], provider);
    });
  }

  $registerRangeFormattingSupport(extension: string, handle: number, selector: unknown, displayName: unknown, supportsRanges: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const name = text(displayName);
    return this.seam.register(extension, handle, monaco => {
      const provider: RangeFormattingProvider = {
        displayName: name,
        provideDocumentRangeFormattingEdits: (model, range, options, token) => this.format(model, token, uri =>
          this.seam.proxy.$provideDocumentRangeFormattingEdits(handle, uri, rangeOrSelection(range), formattingOptions(options), rpcToken(token))),
      };
      if (supportsRanges === true) {
        provider.provideDocumentRangesFormattingEdits = (model, ranges, options, token) => this.format(model, token, uri =>
          this.seam.proxy.$provideDocumentRangesFormattingEdits(handle, uri, ranges.slice(0, MAX_RANGES).map(range => ({
            startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn,
          })), formattingOptions(options), rpcToken(token)));
      }
      return monaco.languages.registerDocumentRangeFormattingEditProvider(checked as Parameters<Languages['registerDocumentRangeFormattingEditProvider']>[0], provider);
    });
  }

  $registerOnTypeFormattingSupport(extension: string, handle: number, selector: unknown, triggerCharacters: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const triggers = strings(triggerCharacters, MAX_CHARACTERS).filter(character => character.length <= 16);
    return this.seam.register(extension, handle, monaco => {
      const provider: OnTypeFormattingProvider = {
        autoFormatTriggerCharacters: triggers,
        provideOnTypeFormattingEdits: (model, at, character, options, token) => this.format(model, token, uri =>
          this.seam.proxy.$provideOnTypeFormattingEdits(handle, uri, position(at), character, formattingOptions(options), rpcToken(token))),
      };
      return monaco.languages.registerOnTypeFormattingEditProvider(checked as Parameters<Languages['registerOnTypeFormattingEditProvider']>[0], provider);
    });
  }

  // --- Code actions ------------------------------------------------------------------------------

  $registerCodeActionSupport(extension: string, handle: number, selector: unknown, metadata: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const value = (metadata && typeof metadata === 'object' ? metadata : {}) as Partial<CodeActionProviderMetadataDto>;
    const kinds = Array.isArray(value.providedCodeActionKinds) ? strings(value.providedCodeActionKinds, MAX_KINDS) : undefined;
    return this.seam.register(extension, handle, monaco => {
      const documentation: { kind: string; command: NonNullable<ReturnType<MainThreadLanguageFeatures['toMonacoCommand']>> }[] = [];
      for (const entry of Array.isArray(value.documentation) ? value.documentation.slice(0, MAX_KINDS) : []) {
        const kind = text(entry?.kind);
        const command = this.seam.toMonacoCommand(monaco, entry?.command);
        if (kind !== undefined && command) {
          documentation.push({ kind, command });
        }
      }
      const provider: CodeActionProvider = {
        provideCodeActions: (model, range, context, token) => this.provideCodeActions(monaco, handle, model, range, context, token),
      };
      const providerMetadata: CodeActionMetadata = { providedCodeActionKinds: kinds, documentation: documentation.length ? documentation : undefined };
      return monaco.languages.registerCodeActionProvider(checked as Parameters<Languages['registerCodeActionProvider']>[0], provider, providerMetadata);
    });
  }

  private async provideCodeActions(
    monaco: MonacoNamespace, handle: number, model: IMonacoTextModel, range: Parameters<CodeActionProvider['provideCodeActions']>[1],
    context: MonacoCodeActionContext, token: MonacoToken,
  ): Promise<MonacoCodeActionList | undefined> {
    const release = (id: unknown) => {
      if (isIndex(id)) {
        void this.seam.proxy.$releaseCodeActions(handle, id).catch(() => {});
      }
    };
    const at = rangeOrSelection(range as EditorRange & Partial<EditorSelection>);
    const contextDto = {
      markers: markers(context?.markers),
      only: typeof context?.only === 'string' && context.only ? text(context.only) : undefined,
      trigger: CODE_ACTION_TRIGGERS.has(context?.trigger) ? context.trigger : 1,
    };
    const dto = await request(model, token, async uri => {
      const result = await this.seam.proxy.$provideCodeActions(handle, uri, at, contextDto, rpcToken(token));
      if (result && token.isCancellationRequested) {
        // Too late: nobody will show it, so the extension host need not keep it.
        release(result.id);
      }
      return result;
    });
    if (!dto) {
      return undefined;
    }
    const actions = this.toCodeActions(monaco, handle, dto);
    if (!actions?.length) {
      release(dto?.id);
      return undefined;
    }
    let released = false;
    return {
      actions,
      dispose: () => {
        if (!released) {
          released = true;
          release(dto.id);
        }
      },
    };
  }

  /** The actions of a list, checked; each one's command asks the extension host to apply it. */
  private toCodeActions(monaco: MonacoNamespace, handle: number, dto: CodeActionListDto): MonacoCodeAction[] | undefined {
    if (!dto || typeof dto !== 'object' || !isIndex(dto.id) || !Array.isArray(dto.actions)) {
      return undefined;
    }
    const apply = this.seam.monacoCommand(monaco, 'applyCodeAction', (target, id, index) => this.applyCodeAction(target, id, index));
    const actions: MonacoCodeAction[] = [];
    for (const action of dto.actions.slice(0, MAX_CODE_ACTIONS) as (CodeActionDto | undefined)[]) {
      const title = text(action?.title);
      if (!action || title === undefined || !isIndex(action.index)) {
        continue;
      }
      const result: MonacoCodeAction = { title, command: { id: apply, title, arguments: [handle, dto.id, action.index] } };
      const kind = text(action.kind);
      if (kind) {
        result.kind = kind;
      }
      if (action.isPreferred === true) {
        result.isPreferred = true;
      }
      const disabled = text(action.disabled);
      if (disabled) {
        result.disabled = disabled;
      }
      if (Array.isArray(action.diagnostics)) {
        result.diagnostics = markers(action.diagnostics) as MonacoCodeAction['diagnostics'];
      }
      actions.push(result);
    }
    return actions;
  }

  /**
   * Runs when the user picks an action. When its edit was not applied (the document changed since the
   * actions were asked for, or cannot be edited), the user is told; its command did not run.
   */
  private async applyCodeAction(handle: unknown, id: unknown, index: unknown): Promise<void> {
    if (!isIndex(handle) || !isIndex(id) || !isIndex(index)) {
      return;
    }
    if (await this.seam.proxy.$applyCodeAction(handle, id, index) === false) {
      this.seam.warn('The code action could not be applied: the document changed or cannot be edited.');
    }
  }

  // --- Rename ------------------------------------------------------------------------------------

  $registerRenameSupport(extension: string, handle: number, selector: unknown, supportsResolveLocation: unknown): Promise<void> {
    const checked = checkSelector(selector);
    return this.seam.register(extension, handle, monaco => {
      const provider: RenameProvider = {
        provideRenameEdits: async (model, at, newName, token) => toRenameEdits(await request(model, token, uri =>
          this.seam.proxy.$provideRenameEdits(handle, uri, position(at), newName, rpcToken(token)))),
      };
      if (supportsResolveLocation === true) {
        provider.resolveRenameLocation = async (model, at, token) => toRenameLocation(await request(model, token, uri =>
          this.seam.proxy.$resolveRenameLocation(handle, uri, position(at), rpcToken(token))), at);
      }
      return monaco.languages.registerRenameProvider(checked as Parameters<Languages['registerRenameProvider']>[0], provider);
    });
  }

  dispose(): void {
    liveGroups.delete(this);
  }
}

/**
 * What Monaco makes of a rename: an empty edit once the extension host applied it (Monaco has nothing
 * left to do), the reason it was refused, or nothing (Monaco asks the next provider).
 */
export function toRenameEdits(dto: RenameResultDto | undefined): MonacoRenameEdits | undefined {
  if (!dto || typeof dto !== 'object') {
    return undefined;
  }
  if ('applied' in dto && dto.applied === true) {
    return { edits: [] };
  }
  const reason = 'rejectReason' in dto ? text(dto.rejectReason) : undefined;
  return reason ? { edits: [], rejectReason: reason } : undefined;
}

/** Where the rename input goes and what it starts with, or the provider's refusal, which Monaco shows. */
export function toRenameLocation(dto: RenameLocationDto | undefined, at: EditorPosition): MonacoRenameLocation | undefined {
  if (!dto || typeof dto !== 'object') {
    return undefined;
  }
  if ('rejectReason' in dto) {
    const reason = text(dto.rejectReason);
    return reason ? {
      range: { startLineNumber: at.lineNumber, startColumn: at.column, endLineNumber: at.lineNumber, endColumn: at.column },
      text: '', rejectReason: reason,
    } : undefined;
  }
  const range = checkRange(dto.range);
  const placeholder = text(dto.text);
  return range && placeholder ? { range, text: placeholder } : undefined;
}

/** The edit groups of the hosts alive now. */
const liveGroups = new Set<MainThreadEdits>();

/**
 * How many code action lists the extension hosts keep now, for tests that look for leaks: a list that
 * Monaco disposed is gone. Not in the command palette.
 */
CommandsRegistry.registerCommand('_workbench.languageFeatures.codeActionCacheSize', async () => {
  const sizes = await Promise.all([...liveGroups].map(group => group.cacheSize().catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
});

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createMainThreadEdits(seam: MainThreadLanguageFeatures): MainThreadEdits {
  return new MainThreadEdits(seam);
}
