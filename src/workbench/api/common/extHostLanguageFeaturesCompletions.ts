import type * as vscode from 'vscode';
import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { URI } from '../../../base/common/uri.js';
import type { HostExtensionDescription } from '../../services/extensions/common/extensionHostProtocol.js';
import type {
  CompletionContextDto, CompletionItemDto, CompletionListDto, CompletionRangeDto, ExtHostCompletionsShape, HoverDto,
  MarkdownStringDto, ResolvedCompletionItemDto, SignatureHelpContextDto, SignatureHelpDto,
} from './extHost.protocol.languageFeatures.js';
import { Range } from './extHostEditorTypes.js';
import {
  completionItemKindToDto, documentationToDto, InsertTextRule, isRange, isSnippetString, markedStringToDto, selectorToDto,
  signatureHelpFromDto, signatureHelpToDto, textEditsToDto,
} from './extHostLanguageConverters.js';
import type { CommandStore, ExtHostLanguageFeatures, LanguageFeatureGroup } from './extHostLanguageFeatures.js';
import {
  CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionTriggerKind, Hover, ParameterInformation,
  SignatureHelp, SignatureHelpTriggerKind, SignatureInformation,
} from './extHostLanguageFeatureTypes.js';
import { positionFromEditor, rangeToEditor } from './extHostTypeConverters.js';
import type { EditorPosition } from './extHostTypeConverters.js';

/*
 * Completions (with resolving), hover and signature help on the extension host.
 *
 * A completion list stays on the extension host under an id until the workbench releases it (Monaco
 * disposes a list when the suggest widget closes or asks again): resolving finds its items there, and
 * the commands of its items live in the list's command store. A list asked for by a request that was
 * cancelled is never kept.
 */

class CompletionsAdapter {
  constructor(readonly provider: vscode.CompletionItemProvider) {}
}

class HoverAdapter {
  constructor(readonly provider: vscode.HoverProvider) {}
}

class SignatureHelpAdapter {
  constructor(readonly provider: vscode.SignatureHelpProvider) {}
}

/** Strings a provider gives as trigger characters; more are dropped. */
const MAX_TRIGGER_CHARACTERS = 64;

interface CachedList {
  readonly handle: number;
  readonly extension: HostExtensionDescription;
  readonly items: vscode.CompletionItem[];
  readonly commands: CommandStore;
  /** What resolving gave each item: an item is resolved once. */
  readonly resolved: Map<number, ResolvedCompletionItemDto>;
}

function triggerCharacters(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === 'string' && value.length > 0).slice(0, MAX_TRIGGER_CHARACTERS);
}

function checkProvider(provider: unknown, method: string): void {
  if (!provider || typeof (provider as Record<string, unknown>)[method] !== 'function') {
    throw new TypeError(`The provider has no '${method}' function.`);
  }
}

/** The document's position of a workbench position; one that is not a position gives undefined. */
function documentPosition(document: vscode.TextDocument, position: EditorPosition): vscode.Position | undefined {
  if (!position || !Number.isSafeInteger(position.lineNumber) || !Number.isSafeInteger(position.column)
    || position.lineNumber < 1 || position.column < 1) {
    return undefined;
  }
  return document.validatePosition(positionFromEditor(position));
}

function labelText(label: unknown): string | undefined {
  if (typeof label === 'string') {
    return label;
  }
  return label && typeof label === 'object' && typeof (label as vscode.CompletionItemLabel).label === 'string'
    ? (label as vscode.CompletionItemLabel).label : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Whether `range` lies on the line of `position`, as Monaco needs of a completion's range. */
function onLine(range: vscode.Range, position: vscode.Position): boolean {
  return range.start.line === position.line && range.end.line === position.line && range.start.character <= range.end.character;
}

/**
 * Where an item goes: its text edit's range, its range or its insert and replace ranges, checked; no
 * range means the list's default. `null` when the item's range is not usable.
 */
function completionRange(item: vscode.CompletionItem, position: vscode.Position): CompletionRangeDto | undefined | null {
  const range = isRange(item.textEdit?.range) ? item.textEdit!.range : item.range;
  if (range === undefined || range === null) {
    return undefined;
  }
  if (isRange(range)) {
    return onLine(range, position) ? rangeToEditor(range) : null;
  }
  const { inserting, replacing } = range as { inserting?: unknown; replacing?: unknown };
  if (!isRange(inserting) || !isRange(replacing) || !onLine(inserting, position) || !onLine(replacing, position)
    || inserting.start.character !== replacing.start.character || inserting.end.character > replacing.end.character) {
    return null;
  }
  return { insert: rangeToEditor(inserting), replace: rangeToEditor(replacing) };
}

/** An item as it crosses; an item without a label or with a range Monaco cannot use is dropped. */
function completionItemToDto(item: vscode.CompletionItem, index: number, position: vscode.Position, commands: CommandStore): CompletionItemDto | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }
  const label = labelText(item.label);
  if (!label) {
    return undefined;
  }
  const range = completionRange(item, position);
  if (range === null) {
    return undefined;
  }
  let insertText = label;
  let insertTextRules = item.keepWhitespace ? InsertTextRule.KeepWhitespace : 0;
  if (item.textEdit && typeof item.textEdit.newText === 'string') {
    insertText = item.textEdit.newText;
  } else if (typeof item.insertText === 'string') {
    insertText = item.insertText;
  } else if (isSnippetString(item.insertText)) {
    insertText = item.insertText.value;
    insertTextRules |= InsertTextRule.InsertAsSnippet;
  }
  const labelDto = typeof item.label === 'string' ? item.label : {
    label, detail: optionalString(item.label.detail), description: optionalString(item.label.description),
  };
  return {
    index,
    label: labelDto,
    kind: completionItemKindToDto(item.kind),
    tags: Array.isArray(item.tags) && item.tags.includes(CompletionItemTag.Deprecated) ? [CompletionItemTag.Deprecated] : undefined,
    detail: optionalString(item.detail),
    documentation: documentationToDto(item.documentation),
    sortText: optionalString(item.sortText),
    filterText: optionalString(item.filterText),
    preselect: item.preselect === true ? true : undefined,
    insertText,
    insertTextRules: insertTextRules || undefined,
    range,
    commitCharacters: Array.isArray(item.commitCharacters)
      ? item.commitCharacters.filter((character): character is string => typeof character === 'string' && character.length > 0) : undefined,
    additionalTextEdits: textEditsToDto(item.additionalTextEdits),
    command: commands.toDto(item.command),
  };
}

/** What an item's insert text and range are, to see whether resolving changed them. */
function insertKey(item: vscode.CompletionItem): string {
  const range = (value: unknown) => isRange(value) ? [value.start.line, value.start.character, value.end.line, value.end.character] : value;
  const itemRange = item.range && !isRange(item.range)
    ? { inserting: range(item.range.inserting), replacing: range(item.range.replacing) } : range(item.range);
  return JSON.stringify([
    typeof item.insertText === 'string' ? item.insertText : isSnippetString(item.insertText) ? ['snippet', item.insertText.value] : undefined,
    itemRange, item.textEdit ? [item.textEdit.newText, range(item.textEdit.range)] : undefined,
  ]);
}

export class ExtHostCompletions implements ExtHostCompletionsShape, LanguageFeatureGroup {
  private readonly lists = new Map<number, CachedList>();
  private nextList = 0;

  readonly types = {
    CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionTriggerKind, Hover, ParameterInformation,
    SignatureHelp, SignatureHelpTriggerKind, SignatureInformation,
  };

  constructor(private readonly features: ExtHostLanguageFeatures) {}

  /** The completion lists kept now, for tests that look for leaks. */
  get cacheSize(): number {
    return this.lists.size;
  }

  api(extension: HostExtensionDescription) {
    const { features } = this;
    return {
      registerCompletionItemProvider: (selector: vscode.DocumentSelector, provider: vscode.CompletionItemProvider, ...characters: string[]) => {
        checkProvider(provider, 'provideCompletionItems');
        const dto = selectorToDto(selector);
        const triggers = triggerCharacters(characters);
        const supportsResolve = typeof provider.resolveCompletionItem === 'function';
        return features.register(extension, new CompletionsAdapter(provider), handle =>
          features.proxy.$registerCompletionsSupport(extension.key, handle, dto, triggers, supportsResolve));
      },
      registerHoverProvider: (selector: vscode.DocumentSelector, provider: vscode.HoverProvider) => {
        checkProvider(provider, 'provideHover');
        const dto = selectorToDto(selector);
        return features.register(extension, new HoverAdapter(provider), handle =>
          features.proxy.$registerHoverSupport(extension.key, handle, dto));
      },
      registerSignatureHelpProvider: (selector: vscode.DocumentSelector, provider: vscode.SignatureHelpProvider,
        first?: string | vscode.SignatureHelpProviderMetadata, ...rest: string[]) => {
        checkProvider(provider, 'provideSignatureHelp');
        const dto = selectorToDto(selector);
        let triggers: string[];
        let retriggers: string[] = [];
        if (first && typeof first === 'object') {
          triggers = triggerCharacters(Array.isArray(first.triggerCharacters) ? first.triggerCharacters : []);
          retriggers = triggerCharacters(Array.isArray(first.retriggerCharacters) ? first.retriggerCharacters : []);
        } else {
          triggers = triggerCharacters(first === undefined ? rest : [first, ...rest]);
        }
        return features.register(extension, new SignatureHelpAdapter(provider), handle =>
          features.proxy.$registerSignatureHelpSupport(extension.key, handle, dto, triggers, retriggers));
      },
    } satisfies Pick<typeof vscode.languages, 'registerCompletionItemProvider' | 'registerHoverProvider' | 'registerSignatureHelpProvider'>;
  }

  async $provideCompletionItems(handle: number, uri: URI, position: EditorPosition, context: CompletionContextDto, token: CancellationToken): Promise<CompletionListDto | undefined> {
    // The list built for this request, until it is kept or dropped.
    let built: { list: CachedList; dto: CompletionListDto } | undefined;
    const drop = () => {
      built?.list.commands.dispose();
      built = undefined;
    };
    const result = await this.features.invoke(handle, CompletionsAdapter, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      const at = document && documentPosition(document, position);
      if (!document || !at) {
        return undefined;
      }
      const triggerKind = [CompletionTriggerKind.Invoke, CompletionTriggerKind.TriggerCharacter, CompletionTriggerKind.TriggerForIncompleteCompletions]
        .includes(context?.triggerKind) ? context.triggerKind as CompletionTriggerKind : CompletionTriggerKind.Invoke;
      const value = await adapter.provider.provideCompletionItems(document, at, token as vscode.CancellationToken, {
        triggerKind, triggerCharacter: optionalString(context?.triggerCharacter),
      });
      const items = Array.isArray(value) ? value : value && Array.isArray(value.items) ? value.items : undefined;
      if (!items || token.isCancellationRequested) {
        return undefined;
      }
      const replace = document.getWordRangeAtPosition(at) ?? new Range(at, at);
      const insert = new Range(replace.start, at.isBefore(replace.start) ? replace.start : at);
      const id = ++this.nextList;
      const list: CachedList = { handle, extension, items: [...items], commands: this.features.createCommandStore(extension), resolved: new Map() };
      const dtos: CompletionItemDto[] = [];
      list.items.forEach((item, index) => {
        const dto = completionItemToDto(item, index, at, list.commands);
        if (dto) {
          dtos.push(dto);
        }
      });
      if (dtos.length < list.items.length) {
        console.warn(`[${extension.id}] ${list.items.length - dtos.length} completion item(s) without a label or with a range off the position's line were dropped.`);
      }
      built = {
        list,
        dto: {
          id, incomplete: !Array.isArray(value) && value!.isIncomplete === true ? true : undefined,
          defaults: { insert: rangeToEditor(insert), replace: rangeToEditor(replace) }, items: dtos,
        },
      };
      if (token.isCancellationRequested) {
        // The request was answered without this list already.
        drop();
        return undefined;
      }
      return built.dto;
    });
    if (!result || !built || built.dto !== result || token.isCancellationRequested) {
      drop();
      return undefined;
    }
    this.lists.set(result.id, built.list);
    return result;
  }

  async $resolveCompletionItem(handle: number, id: number, index: number, token: CancellationToken): Promise<ResolvedCompletionItemDto | undefined> {
    const list = this.lists.get(id);
    const item = list?.handle === handle && Number.isSafeInteger(index) ? list.items[index] : undefined;
    if (!list || !item) {
      return undefined;
    }
    const known = list.resolved.get(index);
    if (known) {
      return known;
    }
    return this.features.invoke(handle, CompletionsAdapter, token, undefined, async (adapter, extension) => {
      if (typeof adapter.provider.resolveCompletionItem !== 'function') {
        return undefined;
      }
      const before = insertKey(item);
      const resolved = await adapter.provider.resolveCompletionItem(item, token as vscode.CancellationToken);
      if (!resolved || typeof resolved !== 'object' || token.isCancellationRequested || this.lists.get(id) !== list) {
        return undefined;
      }
      if (insertKey(resolved) !== before) {
        console.warn(`[${extension.id}] Resolving a completion item changed its insert text or range; the change is ignored.`);
      }
      list.items[index] = resolved;
      const dto: ResolvedCompletionItemDto = {
        detail: optionalString(resolved.detail),
        documentation: documentationToDto(resolved.documentation),
        additionalTextEdits: textEditsToDto(resolved.additionalTextEdits),
        command: list.commands.toDto(resolved.command),
      };
      list.resolved.set(index, dto);
      return dto;
    });
  }

  async $releaseCompletionItems(handle: number, id: number): Promise<void> {
    const list = this.lists.get(id);
    if (list?.handle === handle) {
      this.lists.delete(id);
      list.commands.dispose();
    }
  }

  async $completionCacheSize(): Promise<number> {
    return this.lists.size;
  }

  $provideHover(handle: number, uri: URI, position: EditorPosition, token: CancellationToken): Promise<HoverDto | undefined> {
    return this.features.invoke(handle, HoverAdapter, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      const at = document && documentPosition(document, position);
      if (!document || !at) {
        return undefined;
      }
      const value = await adapter.provider.provideHover(document, at, token as vscode.CancellationToken);
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      const parts: unknown[] = Array.isArray(value.contents) ? value.contents : [value.contents];
      const contents = parts.map(markedStringToDto).filter((part): part is MarkdownStringDto => !!part);
      if (!contents.length) {
        return undefined;
      }
      // As in VS Code: without a range of its own, the hover covers the word at the position.
      const range = isRange(value.range) ? value.range : document.getWordRangeAtPosition(at) ?? new Range(at, at);
      return { contents, range: rangeToEditor(range) };
    });
  }

  $provideSignatureHelp(handle: number, uri: URI, position: EditorPosition, context: SignatureHelpContextDto, token: CancellationToken): Promise<SignatureHelpDto | undefined> {
    return this.features.invoke(handle, SignatureHelpAdapter, token, undefined, async (adapter, extension) => {
      const document = this.features.document(extension, uri);
      const at = document && documentPosition(document, position);
      if (!document || !at) {
        return undefined;
      }
      const triggerKind = [SignatureHelpTriggerKind.Invoke, SignatureHelpTriggerKind.TriggerCharacter, SignatureHelpTriggerKind.ContentChange]
        .includes(context?.triggerKind) ? context.triggerKind as SignatureHelpTriggerKind : SignatureHelpTriggerKind.Invoke;
      const value = await adapter.provider.provideSignatureHelp(document, at, token as vscode.CancellationToken, {
        triggerKind,
        triggerCharacter: optionalString(context?.triggerCharacter),
        isRetrigger: context?.isRetrigger === true,
        activeSignatureHelp: signatureHelpFromDto(context?.activeSignatureHelp),
      });
      return value && typeof value === 'object' ? signatureHelpToDto(value) : undefined;
    });
  }

  /** Forgets the lists of an extension that was released. */
  release(key: string): void {
    for (const [id, list] of [...this.lists]) {
      if (list.extension.key === key) {
        this.lists.delete(id);
        list.commands.dispose();
      }
    }
  }

  dispose(): void {
    for (const list of this.lists.values()) {
      list.commands.dispose();
    }
    this.lists.clear();
  }
}

export function createCompletionsGroup(features: ExtHostLanguageFeatures): ExtHostCompletions {
  return new ExtHostCompletions(features);
}
