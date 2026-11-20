import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import type { LanguageFilter, LanguageSelector } from '../../../editor/common/languageSelector.js';
import type {
  LanguageConfigurationDto, LanguageFilterDto, LanguageSelectorDto, MarkdownStringDto, OnEnterRuleDto, ParameterInformationDto,
  RegExpDto, RelativePatternDto, SignatureHelpDto, SignatureInformationDto,
} from './extHost.protocol.languageFeatures.js';
import { toModelRange } from './extHost.protocol.documents.js';
import type { WorkspaceEditOperation } from './extHost.protocol.documents.js';
import { MarkdownString } from './extHostCommonTypes.js';
import { Range, SnippetString, WorkspaceEdit } from './extHostEditorTypes.js';
import { ParameterInformation, SignatureHelp, SignatureInformation } from './extHostLanguageFeatureTypes.js';
import { markdownToDto, textEditToEditor } from './extHostTypeConverters.js';
import type { EditorTextEdit } from './extHostTypeConverters.js';

/*
 * Conversions between the API's language feature values and what crosses to the workbench. Positions
 * and ranges use the shared converters (`extHostTypeConverters.ts`): the API's are 0-based, the
 * workbench's 1-based with an exclusive end column.
 */

function relativePattern(value: unknown): RelativePatternDto | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const { baseUri, base, pattern } = value as { baseUri?: unknown; base?: unknown; pattern?: unknown };
  if (typeof pattern !== 'string') {
    return undefined;
  }
  if (URI.isUri(baseUri)) {
    return { baseUri, base: baseUri.fsPath, pattern };
  }
  if (typeof base === 'string') {
    // An `IRelativePattern`-like object with a path but no URI, as VS Code takes it.
    const uri = URI.file(base);
    return { baseUri: uri, base: uri.fsPath, pattern };
  }
  return undefined;
}

function filter(value: vscode.DocumentFilter | string): LanguageFilterDto | string {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('A document selector holds strings and document filters.');
  }
  const result: { -readonly [K in keyof LanguageFilterDto]: LanguageFilterDto[K] } = {};
  if (typeof value.language === 'string') {
    result.language = value.language;
  }
  if (typeof value.scheme === 'string') {
    result.scheme = value.scheme;
  }
  if (typeof value.notebookType === 'string') {
    result.notebookType = value.notebookType;
  }
  if (typeof value.pattern === 'string') {
    result.pattern = value.pattern;
  } else if (value.pattern !== undefined) {
    const pattern = relativePattern(value.pattern);
    if (!pattern) {
      throw new TypeError('A document filter pattern is a glob string or a relative pattern.');
    }
    result.pattern = pattern;
  }
  return result;
}

/** The selector as it crosses to the workbench; a selector of another shape throws. */
export function selectorToDto(selector: vscode.DocumentSelector): LanguageSelectorDto {
  if (Array.isArray(selector)) {
    return (selector as ReadonlyArray<vscode.DocumentFilter | string>).map(filter);
  }
  return filter(selector as vscode.DocumentFilter | string);
}

/** The selector as the score reads it: a relative pattern is matched below its base's path. */
export function selectorFromDto(selector: LanguageSelectorDto): LanguageSelector {
  const revive = (value: string | LanguageFilterDto): string | LanguageFilter => typeof value === 'string' ? value : {
    ...value, pattern: value.pattern === undefined || typeof value.pattern === 'string'
      ? value.pattern : { base: value.pattern.base, pattern: value.pattern.pattern },
  };
  return Array.isArray(selector) ? selector.map(revive) : revive(selector as string | LanguageFilterDto);
}

function regExp(value: unknown, name: string): RegExpDto | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!(value instanceof RegExp)) {
    throw new TypeError(`Language configuration '${name}' must be a regular expression.`);
  }
  return { source: value.source, flags: value.flags };
}

function requiredRegExp(value: unknown, name: string): RegExpDto {
  const result = regExp(value, name);
  if (!result) {
    throw new TypeError(`Language configuration '${name}' must be a regular expression.`);
  }
  return result;
}

function pair(value: unknown): readonly [string, string] | undefined {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'
    ? [value[0], value[1]] : undefined;
}

/**
 * The configuration as it crosses: regular expressions as source and flags. As in VS Code, a regular
 * expression that matches the empty string as a word pattern is refused, since the editor would loop on it.
 */
export function languageConfigurationToDto(configuration: vscode.LanguageConfiguration): LanguageConfigurationDto {
  if (!configuration || typeof configuration !== 'object') {
    throw new TypeError('A language configuration is an object.');
  }
  const wordPattern = regExp(configuration.wordPattern, 'wordPattern');
  if (configuration.wordPattern?.test('')) {
    throw new Error(`language configuration: wordPattern '${configuration.wordPattern}' must not match the empty string`);
  }
  const comments = configuration.comments;
  const lineComment = typeof comments?.lineComment === 'string' ? comments.lineComment
    : typeof comments?.lineComment === 'object' && typeof comments.lineComment?.comment === 'string' ? comments.lineComment.comment : undefined;
  const indentation = configuration.indentationRules;
  return {
    comments: comments ? { lineComment, blockComment: pair(comments.blockComment) } : undefined,
    brackets: Array.isArray(configuration.brackets)
      ? configuration.brackets.map(pair).filter((value): value is readonly [string, string] => !!value) : undefined,
    wordPattern,
    indentationRules: indentation ? {
      decreaseIndentPattern: requiredRegExp(indentation.decreaseIndentPattern, 'indentationRules.decreaseIndentPattern'),
      increaseIndentPattern: requiredRegExp(indentation.increaseIndentPattern, 'indentationRules.increaseIndentPattern'),
      indentNextLinePattern: regExp(indentation.indentNextLinePattern, 'indentationRules.indentNextLinePattern'),
      unIndentedLinePattern: regExp(indentation.unIndentedLinePattern, 'indentationRules.unIndentedLinePattern'),
    } : undefined,
    onEnterRules: Array.isArray(configuration.onEnterRules) ? configuration.onEnterRules.map((rule): OnEnterRuleDto => ({
      beforeText: requiredRegExp(rule.beforeText, 'onEnterRules.beforeText'),
      afterText: regExp(rule.afterText, 'onEnterRules.afterText'),
      previousLineText: regExp(rule.previousLineText, 'onEnterRules.previousLineText'),
      action: {
        indentAction: rule.action?.indentAction ?? 0,
        appendText: typeof rule.action?.appendText === 'string' ? rule.action.appendText : undefined,
        removeText: typeof rule.action?.removeText === 'number' ? rule.action.removeText : undefined,
      },
    })) : undefined,
    autoClosingPairs: Array.isArray(configuration.autoClosingPairs)
      ? configuration.autoClosingPairs.filter(entry => typeof entry?.open === 'string' && typeof entry.close === 'string')
        .map(entry => ({
          open: entry.open, close: entry.close,
          notIn: Array.isArray(entry.notIn) ? entry.notIn.map(token => ['other', 'comment', 'string', 'regex'][token] ?? 'other') : undefined,
        }))
      : undefined,
  };
}

// --- Completions, hover and signature help (wr-c9d8.w6j) -----------------------------------------

/**
 * Monaco's `languages.CompletionItemKind` for each of the API's `CompletionItemKind` (the index). The two
 * enums name the same kinds with other numbers.
 */
const completionItemKinds: readonly number[] = [
  /* Text */ 18, /* Method */ 0, /* Function */ 1, /* Constructor */ 2, /* Field */ 3, /* Variable */ 4,
  /* Class */ 5, /* Interface */ 7, /* Module */ 8, /* Property */ 9, /* Unit */ 12, /* Value */ 13,
  /* Enum */ 15, /* Keyword */ 17, /* Snippet */ 28, /* Color */ 19, /* File */ 20, /* Reference */ 21,
  /* Folder */ 23, /* EnumMember */ 16, /* Constant */ 14, /* Struct */ 6, /* Event */ 10, /* Operator */ 11,
  /* TypeParameter */ 24, /* User */ 25, /* Issue */ 26,
];

/** Monaco's `CompletionItemKind.Property`: an item without a kind of its own shows as one, as in VS Code. */
export const DEFAULT_COMPLETION_KIND = 9;

/** Monaco's kind number of an API completion kind; an unknown one is a property, as in VS Code. */
export function completionItemKindToDto(kind: unknown): number {
  return typeof kind === 'number' && Number.isInteger(kind) ? completionItemKinds[kind] ?? DEFAULT_COMPLETION_KIND : DEFAULT_COMPLETION_KIND;
}

/** Monaco's `CompletionItemInsertTextRule` bits. */
export const InsertTextRule = { KeepWhitespace: 1, InsertAsSnippet: 4 } as const;

export function isRange(value: unknown): value is vscode.Range {
  if (value instanceof Range) {
    return true;
  }
  const range = value as { start?: { line?: unknown; character?: unknown }; end?: { line?: unknown; character?: unknown } } | null;
  return !!range && typeof range === 'object' && !!range.start && !!range.end
    && typeof range.start.line === 'number' && typeof range.start.character === 'number'
    && typeof range.end.line === 'number' && typeof range.end.character === 'number';
}

export function isSnippetString(value: unknown): value is vscode.SnippetString {
  return value instanceof SnippetString
    || (!!value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string'
      && typeof (value as { appendTabstop?: unknown }).appendTabstop === 'function');
}

/** Documentation as it crosses: a string stays plain text, any other value with a `value` is markdown. */
export function documentationToDto(value: unknown): string | MarkdownStringDto | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string') {
    return markdownToDto(value as vscode.MarkdownString) as MarkdownStringDto;
  }
  return undefined;
}

/**
 * A hover's part as markdown: a `{ language, value }` marked string is a code block of that language, a
 * plain string is markdown, as in VS Code.
 */
export function markedStringToDto(value: unknown): MarkdownStringDto | undefined {
  if (typeof value === 'string') {
    return { value };
  }
  if (!value || typeof value !== 'object' || typeof (value as { value?: unknown }).value !== 'string') {
    return undefined;
  }
  const { language } = value as { language?: unknown };
  if (!(value instanceof MarkdownString) && typeof language === 'string') {
    return { value: new MarkdownString().appendCodeblock((value as { value: string }).value, language).value };
  }
  return markdownToDto(value as vscode.MarkdownString) as MarkdownStringDto;
}

/** Text edits as they cross; an entry of another shape is dropped. */
export function textEditsToDto(edits: unknown): EditorTextEdit[] | undefined {
  if (!Array.isArray(edits)) {
    return undefined;
  }
  return edits.filter((edit: vscode.TextEdit) => !!edit && isRange(edit.range) && typeof edit.newText === 'string')
    .map((edit: vscode.TextEdit) => textEditToEditor(edit));
}

function parameterToDto(parameter: vscode.ParameterInformation): ParameterInformationDto | undefined {
  if (!parameter || typeof parameter !== 'object') {
    return undefined;
  }
  const { label } = parameter;
  const valid = typeof label === 'string'
    || (Array.isArray(label) && label.length === 2 && label.every(offset => Number.isInteger(offset) && offset >= 0));
  return valid ? { label: typeof label === 'string' ? label : [label[0], label[1]], documentation: documentationToDto(parameter.documentation) } : undefined;
}

function signatureToDto(signature: vscode.SignatureInformation): SignatureInformationDto | undefined {
  if (!signature || typeof signature !== 'object' || typeof signature.label !== 'string') {
    return undefined;
  }
  return {
    label: signature.label,
    documentation: documentationToDto(signature.documentation),
    parameters: Array.isArray(signature.parameters)
      ? signature.parameters.map(parameterToDto).filter((parameter): parameter is ParameterInformationDto => !!parameter) : [],
    activeParameter: typeof signature.activeParameter === 'number' ? signature.activeParameter : undefined,
  };
}

export function signatureHelpToDto(help: vscode.SignatureHelp): SignatureHelpDto {
  return {
    signatures: Array.isArray(help.signatures)
      ? help.signatures.map(signatureToDto).filter((signature): signature is SignatureInformationDto => !!signature) : [],
    activeSignature: typeof help.activeSignature === 'number' ? help.activeSignature : 0,
    activeParameter: typeof help.activeParameter === 'number' ? help.activeParameter : 0,
  };
}

function markdownFromDto(value: string | MarkdownStringDto | undefined): string | vscode.MarkdownString | undefined {
  if (typeof value === 'string' || value === undefined) {
    return value;
  }
  const result = new MarkdownString(String(value.value ?? ''), value.supportThemeIcons);
  result.isTrusted = value.isTrusted as vscode.MarkdownString['isTrusted'];
  result.supportHtml = value.supportHtml;
  result.baseUri = value.baseUri as vscode.Uri | undefined;
  return result;
}

/** The signature help Monaco shows now, as API values, for the provider's context. */
export function signatureHelpFromDto(dto: SignatureHelpDto | undefined): vscode.SignatureHelp | undefined {
  if (!dto || typeof dto !== 'object' || !Array.isArray(dto.signatures)) {
    return undefined;
  }
  const help = new SignatureHelp();
  help.activeSignature = dto.activeSignature;
  help.activeParameter = dto.activeParameter;
  help.signatures = dto.signatures.map(signature => {
    const result = new SignatureInformation(signature.label, markdownFromDto(signature.documentation));
    result.activeParameter = signature.activeParameter;
    result.parameters = (signature.parameters ?? []).map((parameter: ParameterInformationDto) => new ParameterInformation(
      typeof parameter.label === 'string' ? parameter.label : [parameter.label[0], parameter.label[1]],
      markdownFromDto(parameter.documentation)));
    return result;
  });
  return help;
}

// --- Formatting, code actions and rename (wr-c9d8.08x) -------------------------------------------

/** Whether a provider's result is a plain `Command` rather than a `CodeAction` (VS Code tells them apart so). */
export function isCommand(value: unknown): value is vscode.Command {
  return !!value && typeof value === 'object'
    && typeof (value as vscode.Command).command === 'string' && typeof (value as vscode.Command).title === 'string';
}

function resource(value: unknown): URI {
  if (!URI.isUri(value)) {
    throw new TypeError('A workspace edit entry needs a Uri.');
  }
  return value;
}

/**
 * A workspace edit as the bulk edit takes it, in the edit's order. Every text operation carries
 * `version(uri)`, the version of the document the edit was computed for: the bulk edit refuses the whole
 * edit when a document is no longer at it. `undefined` (a file the extension host has no copy of) is
 * not checked. A value that is not the API's `WorkspaceEdit` throws.
 *
 * The same conversion as `ExtHostBulkEdits.apply` (`workspace.applyEdit`), which stamps the version
 * the extension host knows now; a provider's edit needs the version it was computed for instead.
 * Keep the two in step.
 */
export async function workspaceEditToOperations(edit: vscode.WorkspaceEdit, version: (uri: URI) => number | undefined): Promise<WorkspaceEditOperation[]> {
  if (!(edit instanceof WorkspaceEdit)) {
    throw new TypeError('Expected a WorkspaceEdit.');
  }
  const operations: WorkspaceEditOperation[] = [];
  for (const entry of edit.getOperations()) {
    const uri = resource(entry.uri);
    switch (entry.kind) {
      case 'text': {
        const { range, newText, newEol } = entry.edit;
        operations.push({
          kind: 'text', uri, version: version(uri),
          edit: { operations: newEol === undefined ? [{ range: toModelRange(range), text: newText }] : [], eol: newEol },
        });
        break;
      }
      case 'snippet':
        operations.push({
          kind: 'text', uri, version: version(uri), snippet: true, keepWhitespace: entry.edit.keepWhitespace === true,
          edit: { operations: [{ range: toModelRange(entry.edit.range), text: entry.edit.snippet.value }] },
        });
        break;
      case 'create': {
        const contents = entry.options?.contents;
        operations.push({
          kind: 'create', uri, overwrite: entry.options?.overwrite, ignoreIfExists: entry.options?.ignoreIfExists,
          contents: contents && (contents instanceof Uint8Array ? contents : await contents.data()),
        });
        break;
      }
      case 'rename':
        operations.push({
          kind: 'rename', uri, target: resource(entry.newUri),
          overwrite: entry.options?.overwrite, ignoreIfExists: entry.options?.ignoreIfExists,
        });
        break;
      case 'delete':
        operations.push({ kind: 'delete', uri, recursive: entry.options?.recursive, ignoreIfNotExists: entry.options?.ignoreIfNotExists });
        break;
    }
  }
  return operations;
}
