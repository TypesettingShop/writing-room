import type * as vscode from 'vscode';
import { URI } from '../../../base/common/uri.js';
import type { LanguageFilter, LanguageSelector } from '../../../editor/common/languageSelector.js';
import type {
  LanguageConfigurationDto, LanguageFilterDto, LanguageSelectorDto, OnEnterRuleDto, RegExpDto, RelativePatternDto,
} from './extHost.protocol.languageFeatures.js';

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
