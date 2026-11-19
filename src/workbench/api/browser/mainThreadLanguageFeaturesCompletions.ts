import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { UriComponents } from '../../../base/common/uri.js';
import type { IMonacoTextModel, MonacoNamespace } from '../../../editor/browser/monaco.js';
import { CommandsRegistry } from '../../../platform/commands/common/commands.js';
import type {
  CompletionItemDto, CompletionListDto, CompletionRangeDto, HoverDto, MainThreadCompletionsShape, MarkdownStringDto,
  ResolvedCompletionItemDto, SignatureHelpDto,
} from '../common/extHost.protocol.languageFeatures.js';
import type { EditorPosition, EditorRange } from '../common/extHostTypeConverters.js';
import { checkSelector, request } from './mainThreadLanguageFeatures.js';
import type { MainThreadLanguageFeatures } from './mainThreadLanguageFeatures.js';

/*
 * Completions (with resolving), hover and signature help on the workbench side: Monaco providers that
 * ask the extension host. Nothing the host sends reaches Monaco unchecked: strings are cut, numbers and
 * ranges checked, markdown keeps only the fields Monaco knows. A completion list Monaco disposes (the
 * suggest widget closed or asked again) is released on the extension host.
 */

type Languages = MonacoNamespace['languages'];
type CompletionItemProvider = Parameters<Languages['registerCompletionItemProvider']>[1];
type MonacoCompletionItem = Parameters<NonNullable<CompletionItemProvider['resolveCompletionItem']>>[0];
type MonacoCompletionList = NonNullable<Awaited<ReturnType<CompletionItemProvider['provideCompletionItems']>>>;
type HoverProvider = Parameters<Languages['registerHoverProvider']>[1];
type MonacoHover = NonNullable<Awaited<ReturnType<HoverProvider['provideHover']>>>;
type MonacoMarkdown = MonacoHover['contents'][number];
type SignatureHelpProvider = Parameters<Languages['registerSignatureHelpProvider']>[1];
type MonacoSignatureHelpContext = Parameters<SignatureHelpProvider['provideSignatureHelp']>[3];
type MonacoSignatureHelp = NonNullable<Awaited<ReturnType<SignatureHelpProvider['provideSignatureHelp']>>>['value'];
type MonacoRange = MonacoCompletionItem['additionalTextEdits'] extends (infer E)[] | undefined ? E extends { range: infer R } ? R : never : never;
type MonacoPosition = Parameters<CompletionItemProvider['provideCompletionItems']>[1];
type MonacoToken = Parameters<CompletionItemProvider['provideCompletionItems']>[3];

/** Monaco's token as the RPC takes it: the RPC forwards its cancellation to the extension host. */
const rpcToken = (token: MonacoToken) => token as unknown as CancellationToken;

/** Longest label, detail, sort text and the like kept; the rest is cut. */
const MAX_TEXT = 10 * 1024;
/** Longest markdown or insert text kept. */
const MAX_DOCUMENT = 256 * 1024;
/** Items of one completion list kept. */
export const MAX_COMPLETION_ITEMS = 20_000;
const MAX_EDITS = 1024;
const MAX_HOVER_PARTS = 64;
const MAX_SIGNATURES = 256;
const MAX_PARAMETERS = 256;
const MAX_CHARACTERS = 64;
const MAX_ENABLED_COMMANDS = 1024;
const MAX_POSITION = 2 ** 31 - 1;
/** Monaco's `languages.CompletionItemKind` runs from Method (0) to Snippet (28); Property (9) is the default. */
const MAX_COMPLETION_KIND = 28;
const PROPERTY_KIND = 9;
/** Monaco's `CompletionItemTag.Deprecated`. */
const DEPRECATED_TAG = 1;
/** Monaco's `CompletionItemInsertTextRule` bits: KeepWhitespace and InsertAsSnippet. */
const INSERT_TEXT_RULES = 1 | 4;
/** Monaco's `CompletionTriggerKind` and `SignatureHelpTriggerKind` numbers. */
const COMPLETION_TRIGGER_KINDS = new Set([0, 1, 2]);
const SIGNATURE_TRIGGER_KINDS = new Set([1, 2, 3]);

function text(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  if (value.length <= max) {
    return value;
  }
  // Not between the two halves of a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(value[max - 1]) ? max - 1 : max;
  return value.slice(0, end) + '…';
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function line(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_POSITION ? value : undefined;
}

/** A range with 1-based ends, the end not before the start; another value gives undefined. */
export function checkRange(value: unknown): MonacoRange | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const range = value as Partial<Record<keyof EditorRange, unknown>>;
  const startLineNumber = line(range.startLineNumber);
  const startColumn = line(range.startColumn);
  const endLineNumber = line(range.endLineNumber);
  const endColumn = line(range.endColumn);
  if (!startLineNumber || !startColumn || !endLineNumber || !endColumn
    || endLineNumber < startLineNumber || (endLineNumber === startLineNumber && endColumn < startColumn)) {
    return undefined;
  }
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

/** A range on the line of `position`, as a completion's range has to be. */
function lineRange(value: unknown, position: MonacoPosition): MonacoRange | undefined {
  const range = checkRange(value);
  return range && range.startLineNumber === position.lineNumber && range.endLineNumber === position.lineNumber ? range : undefined;
}

function uriComponents(value: unknown): UriComponents | undefined {
  try {
    const uri = URI.isUri(value) ? value : value && typeof value === 'object' ? URI.revive(value as UriComponents) : undefined;
    return uri && { scheme: uri.scheme, authority: uri.authority, path: uri.path, query: uri.query, fragment: uri.fragment };
  } catch {
    return undefined;
  }
}

/**
 * Markdown as Monaco renders it, with only the fields Monaco knows. `isTrusted`, `supportHtml` and
 * `supportThemeIcons` are kept as the extension gave them; Monaco's renderer then leaves command links
 * of untrusted markdown dead and never runs scripts.
 */
export function checkMarkdown(value: unknown): MonacoMarkdown | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const dto = value as Partial<Record<keyof MarkdownStringDto, unknown>>;
  const markdown = text(dto.value, MAX_DOCUMENT);
  if (markdown === undefined) {
    return undefined;
  }
  const result: { -readonly [K in keyof MonacoMarkdown]: MonacoMarkdown[K] } = { value: markdown };
  if (dto.isTrusted === true) {
    result.isTrusted = true;
  } else if (dto.isTrusted && typeof dto.isTrusted === 'object' && Array.isArray((dto.isTrusted as { enabledCommands?: unknown }).enabledCommands)) {
    const commands = ((dto.isTrusted as { enabledCommands: unknown[] }).enabledCommands)
      .filter((command): command is string => typeof command === 'string' && command.length > 0 && command.length <= MAX_TEXT);
    result.isTrusted = { enabledCommands: commands.slice(0, MAX_ENABLED_COMMANDS) };
  }
  if (dto.supportThemeIcons === true) {
    result.supportThemeIcons = true;
  }
  if (dto.supportHtml === true) {
    result.supportHtml = true;
  }
  const baseUri = uriComponents(dto.baseUri);
  if (baseUri) {
    result.baseUri = baseUri;
  }
  return result;
}

function documentation(value: unknown): string | MonacoMarkdown | undefined {
  return typeof value === 'string' ? text(value, MAX_DOCUMENT) : checkMarkdown(value);
}

function characters(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((character): character is string => typeof character === 'string' && character.length > 0 && character.length <= 16)
      .slice(0, MAX_CHARACTERS)
    : [];
}

function textEdits(value: unknown): { range: MonacoRange; text: string }[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const edits: { range: MonacoRange; text: string }[] = [];
  for (const edit of value.slice(0, MAX_EDITS)) {
    const range = checkRange(edit?.range);
    const editText = text(edit?.text, MAX_DOCUMENT);
    if (range && editText !== undefined) {
      edits.push({ range, text: editText });
    }
  }
  return edits;
}

function label(value: unknown): MonacoCompletionItem['label'] | undefined {
  if (typeof value === 'string') {
    return value ? text(value) : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const name = text((value as { label?: unknown }).label);
  return name ? {
    label: name,
    detail: text((value as { detail?: unknown }).detail),
    description: text((value as { description?: unknown }).description),
  } : undefined;
}

/** Where an item goes: its own range if Monaco can use it, otherwise the list's default. */
function completionRange(value: CompletionRangeDto | undefined, defaults: { insert: MonacoRange; replace: MonacoRange }, position: MonacoPosition): MonacoCompletionItem['range'] {
  if (value && typeof value === 'object' && 'insert' in value) {
    const insert = lineRange(value.insert, position);
    const replace = lineRange(value.replace, position);
    if (insert && replace && insert.startColumn === replace.startColumn) {
      return { insert, replace };
    }
  } else if (value !== undefined) {
    const range = lineRange(value, position);
    if (range) {
      return range;
    }
  }
  return defaults;
}

export class MainThreadCompletions implements MainThreadCompletionsShape, IDisposable {
  /** Which list and item a Monaco item is, for resolving. */
  private readonly origins = new WeakMap<MonacoCompletionItem, { readonly id: number; readonly index: number }>();

  constructor(private readonly seam: MainThreadLanguageFeatures) {
    liveGroups.add(this);
  }

  /** How many completion lists the extension host keeps now. */
  cacheSize(): Promise<number> {
    return this.seam.proxy.$completionCacheSize();
  }

  $registerCompletionsSupport(extension: string, handle: number, selector: unknown, triggerCharacters: unknown, supportsResolve: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const triggers = characters(triggerCharacters);
    return this.seam.register(extension, handle, monaco => {
      const provider: CompletionItemProvider = {
        triggerCharacters: triggers,
        provideCompletionItems: (model, position, context, token) => this.provideCompletionItems(monaco, handle, model, position, context, token),
      };
      if (supportsResolve === true) {
        provider.resolveCompletionItem = (item, token) => this.resolveCompletionItem(monaco, handle, item, token);
      }
      return monaco.languages.registerCompletionItemProvider(checked as Parameters<Languages['registerCompletionItemProvider']>[0], provider);
    });
  }

  private async provideCompletionItems(
    monaco: MonacoNamespace, handle: number, model: IMonacoTextModel, position: MonacoPosition,
    context: Parameters<CompletionItemProvider['provideCompletionItems']>[2], token: MonacoToken,
  ): Promise<MonacoCompletionList | undefined> {
    const at: EditorPosition = { lineNumber: position.lineNumber, column: position.column };
    const release = (id: unknown) => {
      if (Number.isSafeInteger(id)) {
        void this.seam.proxy.$releaseCompletionItems(handle, id as number).catch(() => {});
      }
    };
    const dto = await request(model, token, async uri => {
      const result = await this.seam.proxy.$provideCompletionItems(handle, uri, at, {
        triggerKind: COMPLETION_TRIGGER_KINDS.has(context?.triggerKind) ? context.triggerKind : 0,
        triggerCharacter: typeof context?.triggerCharacter === 'string' ? context.triggerCharacter : undefined,
      }, rpcToken(token));
      if (result && token.isCancellationRequested) {
        // Too late: nobody will show it, so the extension host need not keep it.
        release(result.id);
      }
      return result;
    });
    if (!dto) {
      return undefined;
    }
    const list = this.toCompletionList(monaco, dto, position);
    if (!list) {
      release(dto.id);
      return undefined;
    }
    let released = false;
    list.dispose = () => {
      if (!released) {
        released = true;
        release(dto.id);
      }
    };
    return list;
  }

  private toCompletionList(monaco: MonacoNamespace, dto: CompletionListDto, position: MonacoPosition): MonacoCompletionList | undefined {
    if (!dto || typeof dto !== 'object' || !Number.isSafeInteger(dto.id) || !Array.isArray(dto.items)) {
      return undefined;
    }
    const empty = { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column };
    const replace = lineRange(dto.defaults?.replace, position) ?? empty;
    let insert = lineRange(dto.defaults?.insert, position);
    if (!insert || insert.startColumn !== replace.startColumn) {
      // Inserting runs from the start of the replaced range to the cursor.
      insert = { ...replace, endColumn: Math.max(replace.startColumn, Math.min(position.column, replace.endColumn)) };
    }
    const defaults = { insert, replace };
    const suggestions: MonacoCompletionItem[] = [];
    for (const item of dto.items.slice(0, MAX_COMPLETION_ITEMS)) {
      const suggestion = this.toCompletionItem(monaco, item, defaults, position);
      if (suggestion) {
        suggestions.push(suggestion);
        this.origins.set(suggestion, { id: dto.id, index: item.index });
      }
    }
    return { suggestions, incomplete: dto.incomplete === true };
  }

  private toCompletionItem(
    monaco: MonacoNamespace, dto: CompletionItemDto, defaults: { insert: MonacoRange; replace: MonacoRange }, position: MonacoPosition,
  ): MonacoCompletionItem | undefined {
    if (!dto || typeof dto !== 'object' || !Number.isSafeInteger(dto.index)) {
      return undefined;
    }
    const itemLabel = label(dto.label);
    if (!itemLabel) {
      return undefined;
    }
    const kind = Number.isInteger(dto.kind) && dto.kind >= 0 && dto.kind <= MAX_COMPLETION_KIND ? dto.kind : PROPERTY_KIND;
    const insertText = text(dto.insertText, MAX_DOCUMENT) ?? (typeof itemLabel === 'string' ? itemLabel : itemLabel.label);
    const item: MonacoCompletionItem = {
      label: itemLabel,
      kind,
      insertText,
      range: completionRange(dto.range, defaults, position),
    };
    if (Array.isArray(dto.tags) && dto.tags.includes(DEPRECATED_TAG)) {
      item.tags = [DEPRECATED_TAG];
    }
    const rules = Number.isInteger(dto.insertTextRules) ? (dto.insertTextRules as number) & INSERT_TEXT_RULES : 0;
    if (rules) {
      item.insertTextRules = rules;
    }
    const fields = {
      detail: text(dto.detail),
      documentation: documentation(dto.documentation),
      sortText: text(dto.sortText),
      filterText: text(dto.filterText),
    };
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) {
        (item as unknown as Record<string, unknown>)[name] = value;
      }
    }
    if (dto.preselect === true) {
      item.preselect = true;
    }
    if (dto.commitCharacters !== undefined) {
      item.commitCharacters = characters(dto.commitCharacters);
    }
    const edits = textEdits(dto.additionalTextEdits);
    if (edits?.length) {
      item.additionalTextEdits = edits;
    }
    const command = this.seam.toMonacoCommand(monaco, dto.command);
    if (command) {
      item.command = command;
    }
    return item;
  }

  private async resolveCompletionItem(monaco: MonacoNamespace, handle: number, item: MonacoCompletionItem, token: MonacoToken): Promise<MonacoCompletionItem> {
    const origin = this.origins.get(item);
    if (!origin || token.isCancellationRequested) {
      return item;
    }
    let dto: ResolvedCompletionItemDto | undefined;
    try {
      dto = await this.seam.proxy.$resolveCompletionItem(handle, origin.id, origin.index, rpcToken(token));
    } catch {
      return item;
    }
    if (!dto || typeof dto !== 'object' || token.isCancellationRequested) {
      return item;
    }
    // Only these may change: the insert text and the range stay what the list gave.
    const resolved: MonacoCompletionItem = { ...item };
    const detail = text(dto.detail);
    const doc = documentation(dto.documentation);
    const edits = textEdits(dto.additionalTextEdits);
    const command = this.seam.toMonacoCommand(monaco, dto.command);
    if (detail !== undefined) {
      resolved.detail = detail;
    }
    if (doc !== undefined) {
      resolved.documentation = doc;
    }
    if (edits?.length) {
      resolved.additionalTextEdits = edits;
    }
    if (command) {
      resolved.command = command;
    }
    this.origins.set(resolved, origin);
    return resolved;
  }

  $registerHoverSupport(extension: string, handle: number, selector: unknown): Promise<void> {
    const checked = checkSelector(selector);
    return this.seam.register(extension, handle, monaco => monaco.languages.registerHoverProvider(
      checked as Parameters<Languages['registerHoverProvider']>[0], {
        provideHover: async (model, position, token) => {
          const at: EditorPosition = { lineNumber: position.lineNumber, column: position.column };
          const dto = await request(model, token, uri => this.seam.proxy.$provideHover(handle, uri, at, rpcToken(token)));
          return toHover(dto);
        },
      }));
  }

  $registerSignatureHelpSupport(extension: string, handle: number, selector: unknown, triggerCharacters: unknown, retriggerCharacters: unknown): Promise<void> {
    const checked = checkSelector(selector);
    const triggers = characters(triggerCharacters);
    const retriggers = characters(retriggerCharacters);
    return this.seam.register(extension, handle, monaco => monaco.languages.registerSignatureHelpProvider(
      checked as Parameters<Languages['registerSignatureHelpProvider']>[0], {
        signatureHelpTriggerCharacters: triggers,
        signatureHelpRetriggerCharacters: retriggers,
        provideSignatureHelp: async (model, position, token, context) => {
          const at: EditorPosition = { lineNumber: position.lineNumber, column: position.column };
          const dto = await request(model, token, uri => this.seam.proxy.$provideSignatureHelp(handle, uri, at, signatureContext(context), rpcToken(token)));
          const value = toSignatureHelp(dto);
          return value && { value, dispose: () => {} };
        },
      }));
  }

  dispose(): void {
    liveGroups.delete(this);
  }
}

/** A hover the extension host sent, checked; one without contents is none. */
export function toHover(dto: HoverDto | undefined): MonacoHover | undefined {
  if (!dto || typeof dto !== 'object' || !Array.isArray(dto.contents)) {
    return undefined;
  }
  const contents = dto.contents.slice(0, MAX_HOVER_PARTS).map(checkMarkdown).filter((part): part is MonacoMarkdown => !!part);
  if (!contents.length) {
    return undefined;
  }
  const range = checkRange(dto.range);
  return range ? { contents, range } : { contents };
}

/** Signature help the extension host sent, checked; the active signature is one that exists. */
export function toSignatureHelp(dto: SignatureHelpDto | undefined): MonacoSignatureHelp | undefined {
  if (!dto || typeof dto !== 'object' || !Array.isArray(dto.signatures)) {
    return undefined;
  }
  const signatures: MonacoSignatureHelp['signatures'] = [];
  for (const signature of dto.signatures.slice(0, MAX_SIGNATURES)) {
    const signatureLabel = text(signature?.label);
    if (signatureLabel === undefined) {
      continue;
    }
    const parameters = (Array.isArray(signature.parameters) ? signature.parameters.slice(0, MAX_PARAMETERS) : []).map((parameter: SignatureHelpDto['signatures'][number]['parameters'][number] | undefined) => {
      const value = parameter?.label;
      let parameterLabel: string | [number, number];
      if (Array.isArray(value)) {
        const [start, end] = [count(value[0]), count(value[1])];
        // Offsets outside the label point at nothing; the parameter keeps its place.
        parameterLabel = start !== undefined && end !== undefined && start <= end && end <= signatureLabel.length ? [start, end] : [0, 0];
      } else {
        parameterLabel = text(value) ?? '';
      }
      const doc = documentation(parameter?.documentation);
      return doc === undefined ? { label: parameterLabel } : { label: parameterLabel, documentation: doc };
    });
    const result: MonacoSignatureHelp['signatures'][number] = { label: signatureLabel, parameters };
    const doc = documentation(signature.documentation);
    if (doc !== undefined) {
      result.documentation = doc;
    }
    const active = count(signature.activeParameter);
    if (active !== undefined) {
      result.activeParameter = active;
    }
    signatures.push(result);
  }
  if (!signatures.length) {
    return undefined;
  }
  return {
    signatures,
    activeSignature: Math.min(count(dto.activeSignature) ?? 0, signatures.length - 1),
    activeParameter: count(dto.activeParameter) ?? 0,
  };
}

/** Monaco's signature help context as it crosses: the help shown now goes back as plain values. */
function signatureContext(context: MonacoSignatureHelpContext) {
  const active = context?.activeSignatureHelp;
  return {
    triggerKind: SIGNATURE_TRIGGER_KINDS.has(context?.triggerKind) ? context.triggerKind : 1,
    triggerCharacter: typeof context?.triggerCharacter === 'string' ? context.triggerCharacter : undefined,
    isRetrigger: context?.isRetrigger === true,
    activeSignatureHelp: active ? {
      activeSignature: active.activeSignature,
      activeParameter: active.activeParameter,
      signatures: active.signatures.map(signature => ({
        label: signature.label,
        documentation: signature.documentation,
        activeParameter: signature.activeParameter,
        parameters: signature.parameters.map(parameter => ({ label: parameter.label, documentation: parameter.documentation })),
      })),
    } as SignatureHelpDto : undefined,
  };
}

/** The completion groups of the hosts alive now. */
const liveGroups = new Set<MainThreadCompletions>();

/**
 * How many completion lists the extension hosts keep now, for tests that look for leaks: a list that
 * Monaco disposed is gone. Not in the command palette.
 */
CommandsRegistry.registerCommand('_workbench.languageFeatures.completionCacheSize', async () => {
  const sizes = await Promise.all([...liveGroups].map(group => group.cacheSize().catch(() => 0)));
  return sizes.reduce((sum, size) => sum + size, 0);
});

/** The group's factory; a function declaration, so the seam can list it while the two modules load each other. */
export function createMainThreadCompletions(seam: MainThreadLanguageFeatures): MainThreadCompletions {
  return new MainThreadCompletions(seam);
}
