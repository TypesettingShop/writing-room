import { parseJSONC } from '../../../../base/common/jsonc.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';
import { extensionResourceLimits } from '../../../services/extensions/common/extensionResources.js';

// A language's `configuration` file (`language-configuration.json`): comments, brackets, auto closing and
// surrounding pairs, the word pattern, indentation and on-enter rules, and folding markers. Each field is
// checked on its own, as in VS Code: a wrong entry or a regular expression that does not compile drops
// that entry, never the whole file. The result has the shape of Monaco's `LanguageConfiguration`, which
// the browser side hands to Monaco unchanged.

export type CharacterPair = [string, string];

export interface ILineCommentConfig {
  readonly comment: string;
  readonly noIndent?: boolean;
}

export const enum IndentAction {
  None = 0,
  Indent = 1,
  IndentOutdent = 2,
  Outdent = 3,
}

export interface ILanguageConfigurationData {
  comments?: { lineComment?: string | ILineCommentConfig; blockComment?: CharacterPair };
  brackets?: CharacterPair[];
  wordPattern?: RegExp;
  indentationRules?: {
    decreaseIndentPattern: RegExp;
    increaseIndentPattern: RegExp;
    indentNextLinePattern?: RegExp;
    unIndentedLinePattern?: RegExp;
  };
  onEnterRules?: {
    beforeText: RegExp;
    afterText?: RegExp;
    previousLineText?: RegExp;
    action: { indentAction: IndentAction; appendText?: string; removeText?: number };
  }[];
  autoClosingPairs?: { open: string; close: string; notIn?: string[] }[];
  surroundingPairs?: { open: string; close: string }[];
  colorizedBracketPairs?: CharacterPair[];
  autoCloseBefore?: string;
  folding?: { offSide?: boolean; markers?: { start: RegExp; end: RegExp } };
}

type Report = (message: string) => void;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isCharacterPair(value: unknown): value is CharacterPair {
  return isStringArray(value) && value.length === 2;
}

/** A pattern as a string, or `{ pattern, flags }`: the form keeps flags such as `u`, which `\p{...}` needs. */
function parseRegExp(value: unknown, path: string, report: Report): RegExp | undefined {
  let pattern: string;
  let flags: string | undefined;
  if (typeof value === 'string') {
    pattern = value;
  } else if (isRecord(value)) {
    if (typeof value.pattern !== 'string') {
      report(`expected \`${path}.pattern\` to be a string.`);
      return undefined;
    }
    if (value.flags !== undefined && typeof value.flags !== 'string') {
      report(`expected \`${path}.flags\` to be a string.`);
      return undefined;
    }
    pattern = value.pattern;
    flags = value.flags as string | undefined;
  } else {
    report(`expected \`${path}\` to be a string or an object.`);
    return undefined;
  }
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    report(`invalid regular expression in \`${path}\`: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseComments(value: unknown, report: Report): ILanguageConfigurationData['comments'] {
  if (!isRecord(value)) {
    report('expected `comments` to be an object.');
    return undefined;
  }
  const result: NonNullable<ILanguageConfigurationData['comments']> = {};
  const { lineComment, blockComment } = value;
  if (typeof lineComment === 'string') {
    result.lineComment = lineComment;
  } else if (isRecord(lineComment) && typeof lineComment.comment === 'string') {
    result.lineComment = { comment: lineComment.comment, noIndent: lineComment.noIndent === true || undefined };
  } else if (lineComment !== undefined) {
    report('expected `comments.lineComment` to be a string or an object with a `comment` string.');
  }
  if (isCharacterPair(blockComment)) {
    result.blockComment = [blockComment[0], blockComment[1]];
  } else if (blockComment !== undefined) {
    report('expected `comments.blockComment` to be an array of two strings.');
  }
  return result.lineComment !== undefined || result.blockComment ? result : undefined;
}

function parsePairList(value: unknown, path: string, report: Report): CharacterPair[] | undefined {
  if (!Array.isArray(value)) {
    report(`expected \`${path}\` to be an array.`);
    return undefined;
  }
  const result: CharacterPair[] = [];
  value.forEach((pair, index) => {
    if (isCharacterPair(pair)) {
      result.push([pair[0], pair[1]]);
    } else {
      report(`expected \`${path}[${index}]\` to be an array of two strings.`);
    }
  });
  return result;
}

function parseOpenClose(
  value: unknown, path: string, report: Report, unsupported: Set<string>, conditional: boolean,
): { open: string; close: string; notIn?: string[] } | undefined {
  if (isCharacterPair(value)) {
    return { open: value[0], close: value[1] };
  }
  if (!isRecord(value)) {
    report(`expected \`${path}\` to be an array of two strings or an object.`);
    return undefined;
  }
  if (typeof value.open !== 'string' || typeof value.close !== 'string') {
    report(`expected \`${path}.open\` and \`${path}.close\` to be strings.`);
    return undefined;
  }
  const pair: { open: string; close: string; notIn?: string[] } = { open: value.open, close: value.close };
  if (conditional && value.notIn !== undefined) {
    if (!isStringArray(value.notIn)) {
      report(`expected \`${path}.notIn\` to be a string array.`);
      return undefined;
    }
    pair.notIn = [...value.notIn];
  }
  if (conditional && value.beforeText !== undefined) {
    // Monaco's auto closing pairs have no condition on the text before; the pair still closes.
    unsupported.add('autoClosingPairs[].beforeText');
  }
  return pair;
}

function parsePairObjects<T>(
  value: unknown, path: string, report: Report, parse: (entry: unknown, path: string) => T | undefined,
): T[] | undefined {
  if (!Array.isArray(value)) {
    report(`expected \`${path}\` to be an array.`);
    return undefined;
  }
  const result: T[] = [];
  value.forEach((entry, index) => {
    const parsed = parse(entry, `${path}[${index}]`);
    if (parsed) {
      result.push(parsed);
    }
  });
  return result;
}

function parseIndentationRules(value: unknown, report: Report): ILanguageConfigurationData['indentationRules'] {
  if (!isRecord(value)) {
    report('expected `indentationRules` to be an object.');
    return undefined;
  }
  const decreaseIndentPattern = parseRegExp(value.decreaseIndentPattern, 'indentationRules.decreaseIndentPattern', report);
  const increaseIndentPattern = parseRegExp(value.increaseIndentPattern, 'indentationRules.increaseIndentPattern', report);
  if (!decreaseIndentPattern || !increaseIndentPattern) {
    return undefined;
  }
  const rules: NonNullable<ILanguageConfigurationData['indentationRules']> = { decreaseIndentPattern, increaseIndentPattern };
  if (value.indentNextLinePattern !== undefined) {
    rules.indentNextLinePattern = parseRegExp(value.indentNextLinePattern, 'indentationRules.indentNextLinePattern', report);
  }
  if (value.unIndentedLinePattern !== undefined) {
    rules.unIndentedLinePattern = parseRegExp(value.unIndentedLinePattern, 'indentationRules.unIndentedLinePattern', report);
  }
  return rules;
}

const indentActions: Readonly<Record<string, IndentAction>> = {
  none: IndentAction.None, indent: IndentAction.Indent, indentOutdent: IndentAction.IndentOutdent, outdent: IndentAction.Outdent,
};

function parseOnEnterRule(value: unknown, path: string, report: Report): NonNullable<ILanguageConfigurationData['onEnterRules']>[number] | undefined {
  if (!isRecord(value) || !isRecord(value.action)) {
    report(`expected \`${path}\` to be an object with an \`action\` object.`);
    return undefined;
  }
  const { action } = value;
  const indentAction = typeof action.indent === 'string' && Object.hasOwn(indentActions, action.indent)
    ? indentActions[action.indent] : undefined;
  if (indentAction === undefined) {
    report(`expected \`${path}.action.indent\` to be 'none', 'indent', 'indentOutdent' or 'outdent'.`);
    return undefined;
  }
  const beforeText = parseRegExp(value.beforeText, `${path}.beforeText`, report);
  if (!beforeText) {
    return undefined;
  }
  const rule: NonNullable<ILanguageConfigurationData['onEnterRules']>[number] = { beforeText, action: { indentAction } };
  if (typeof action.appendText === 'string') {
    rule.action.appendText = action.appendText;
  } else if (action.appendText !== undefined) {
    report(`expected \`${path}.action.appendText\` to be a string.`);
  }
  if (typeof action.removeText === 'number') {
    rule.action.removeText = action.removeText;
  } else if (action.removeText !== undefined) {
    report(`expected \`${path}.action.removeText\` to be a number.`);
  }
  if (value.afterText !== undefined) {
    rule.afterText = parseRegExp(value.afterText, `${path}.afterText`, report);
  }
  if (value.previousLineText !== undefined) {
    rule.previousLineText = parseRegExp(value.previousLineText, `${path}.previousLineText`, report);
  }
  return rule;
}

const knownKeys = new Set([
  'comments', 'brackets', 'wordPattern', 'indentationRules', 'onEnterRules', 'autoClosingPairs', 'surroundingPairs',
  'colorizedBracketPairs', 'autoCloseBefore', 'folding',
]);

/**
 * Turns the parsed JSON of a configuration file into Monaco's shape. `report` receives one message per
 * entry it drops; `unsupported` receives the names of fields Monaco has no place for, which are left out.
 */
export function parseLanguageConfiguration(
  json: unknown, report: Report, unsupported: (field: string) => void = () => {},
): ILanguageConfigurationData {
  if (!isRecord(json)) {
    report('invalid format, a JSON object is expected.');
    return {};
  }
  const result: ILanguageConfigurationData = {};
  const unknown = new Set<string>();
  for (const key of Object.keys(json)) {
    if (!knownKeys.has(key)) {
      unknown.add(key);
    }
  }
  if (json.comments !== undefined) {
    result.comments = parseComments(json.comments, report);
  }
  if (json.brackets !== undefined) {
    result.brackets = parsePairList(json.brackets, 'brackets', report);
  }
  if (json.colorizedBracketPairs !== undefined) {
    result.colorizedBracketPairs = parsePairList(json.colorizedBracketPairs, 'colorizedBracketPairs', report);
  }
  if (json.autoClosingPairs !== undefined) {
    result.autoClosingPairs = parsePairObjects(json.autoClosingPairs, 'autoClosingPairs', report,
      (entry, path) => parseOpenClose(entry, path, report, unknown, true));
  }
  if (json.surroundingPairs !== undefined) {
    result.surroundingPairs = parsePairObjects(json.surroundingPairs, 'surroundingPairs', report,
      (entry, path) => {
        const pair = parseOpenClose(entry, path, report, unknown, false);
        return pair && { open: pair.open, close: pair.close };
      });
  }
  if (typeof json.autoCloseBefore === 'string') {
    result.autoCloseBefore = json.autoCloseBefore;
  } else if (json.autoCloseBefore !== undefined) {
    report('expected `autoCloseBefore` to be a string.');
  }
  if (json.wordPattern !== undefined) {
    result.wordPattern = parseRegExp(json.wordPattern, 'wordPattern', report);
  }
  if (json.indentationRules !== undefined) {
    result.indentationRules = parseIndentationRules(json.indentationRules, report);
  }
  if (json.onEnterRules !== undefined) {
    result.onEnterRules = parsePairObjects(json.onEnterRules, 'onEnterRules', report,
      (entry, path) => parseOnEnterRule(entry, path, report));
  }
  if (isRecord(json.folding)) {
    const { offSide, markers } = json.folding;
    const folding: NonNullable<ILanguageConfigurationData['folding']> = {};
    if (typeof offSide === 'boolean') {
      folding.offSide = offSide;
    }
    if (isRecord(markers)) {
      const start = parseRegExp(markers.start, 'folding.markers.start', report);
      const end = parseRegExp(markers.end, 'folding.markers.end', report);
      if (start && end) {
        folding.markers = { start, end };
      }
    } else if (markers !== undefined) {
      report('expected `folding.markers` to be an object.');
    }
    result.folding = folding;
  } else if (json.folding !== undefined) {
    report('expected `folding` to be an object.');
  }
  for (const field of unknown) {
    unsupported(field);
  }
  for (const key of Object.keys(result) as (keyof ILanguageConfigurationData)[]) {
    if (result[key] === undefined) {
      delete result[key];
    }
  }
  return result;
}

/**
 * Reads one configuration file of `languageId` through the file service, at most 8 MiB, and parses it.
 * A file that cannot be read or parsed gives an empty configuration and a warning: the language works
 * without it.
 */
export async function readLanguageConfiguration(
  files: IFileService, languageId: string, file: URI, warn: (message: string) => void = message => console.warn(message),
): Promise<ILanguageConfigurationData> {
  const prefix = `[${languageId}] ${file.toString()}: language configuration: `;
  let text: string;
  try {
    const { value } = await files.readFile(file, { limits: { size: extensionResourceLimits.resource } });
    text = new TextDecoder().decode(value);
  } catch (error) {
    warn(prefix + `could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  const json = parseJSONC(text);
  if (json === undefined) {
    warn(prefix + 'is not valid JSON.');
    return {};
  }
  const unsupported: string[] = [];
  const configuration = parseLanguageConfiguration(json, message => warn(prefix + message), field => unsupported.push(field));
  if (unsupported.length) {
    warn(prefix + `the editor does not support ${unsupported.map(field => '`' + field + '`').join(', ')}; left out.`);
  }
  return configuration;
}
