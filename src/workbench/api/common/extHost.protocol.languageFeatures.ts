import type { URI } from '../../../base/common/uri.js';
import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

/*
 * Language features: extensions register providers with `languages.register*Provider`, and the
 * workbench registers a Monaco provider for each that asks the extension host. A call carries the
 * provider's handle, the document's URI and positions or ranges, never the text: the extension host
 * finds the document in its own copy. Positions and ranges are Monaco's: 1-based, the end column
 * exclusive. URIs cross as RPC URI values. The last argument of a `$provide*` call is the cancellation
 * token; cancelling it cancels the provider's token across the RPC.
 *
 * Each group of features adds its own section of shapes below; the area merges them into the two
 * shapes at the end.
 */

/** A relative pattern: `base` is the file system path of `baseUri`, which the score matches against. */
export interface RelativePatternDto {
  readonly base: string;
  readonly baseUri: URI;
  readonly pattern: string;
}

export interface LanguageFilterDto {
  readonly language?: string;
  readonly scheme?: string;
  readonly pattern?: string | RelativePatternDto;
  readonly notebookType?: string;
}

export type LanguageSelectorDto = string | LanguageFilterDto | ReadonlyArray<string | LanguageFilterDto>;

/** A regular expression, as source and flags: the workbench builds its own. */
export interface RegExpDto {
  readonly source: string;
  readonly flags: string;
}

export interface OnEnterRuleDto {
  readonly beforeText: RegExpDto;
  readonly afterText?: RegExpDto;
  readonly previousLineText?: RegExpDto;
  readonly action: { readonly indentAction: number; readonly appendText?: string; readonly removeText?: number };
}

export interface LanguageConfigurationDto {
  readonly comments?: { readonly lineComment?: string; readonly blockComment?: readonly [string, string] };
  readonly brackets?: ReadonlyArray<readonly [string, string]>;
  readonly wordPattern?: RegExpDto;
  readonly indentationRules?: {
    readonly decreaseIndentPattern: RegExpDto;
    readonly increaseIndentPattern: RegExpDto;
    readonly indentNextLinePattern?: RegExpDto;
    readonly unIndentedLinePattern?: RegExpDto;
  };
  readonly onEnterRules?: readonly OnEnterRuleDto[];
  readonly autoClosingPairs?: ReadonlyArray<{ readonly open: string; readonly close: string; readonly notIn?: readonly string[] }>;
}

// --- The seam ------------------------------------------------------------------------------------

export interface MainThreadLanguageFeaturesSeamShape {
  /** Removes a registration of `extension`. A handle of another extension, or one already gone, is ignored. */
  $unregister(extension: string, handle: number): Promise<void>;
  /** Sets a language configuration of `extension` for `languageId`, until `$unregister(handle)`. */
  $setLanguageConfiguration(extension: string, handle: number, languageId: string, configuration: LanguageConfigurationDto): Promise<void>;
}

// --- The merged shapes ---------------------------------------------------------------------------

export type MainThreadLanguageFeaturesShape = MainThreadLanguageFeaturesSeamShape;

export type ExtHostLanguageFeaturesShape = object;

/**
 * The `$` methods of every feature group, bound, under one object: each side answers under one RPC
 * identifier. Two groups may not share a name.
 */
export function mergeHandlers(groups: readonly object[]): Record<string, unknown> {
  const handlers: Record<string, unknown> = {};
  for (const group of groups) {
    const names = new Set<string>();
    for (let object: object | null = group; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
      for (const name of Object.getOwnPropertyNames(object)) {
        if (name.startsWith('$') && typeof (group as Record<string, unknown>)[name] === 'function') {
          names.add(name);
        }
      }
    }
    for (const name of names) {
      if (Object.hasOwn(handlers, name)) {
        throw new Error(`Language feature method '${name}' exists twice.`);
      }
      handlers[name] = ((group as Record<string, unknown>)[name] as (...args: unknown[]) => unknown).bind(group);
    }
  }
  return handlers;
}

export const MainThreadLanguageFeaturesProxy = createProxyIdentifier<MainThreadLanguageFeaturesShape>('MainThreadLanguageFeatures');
export const ExtHostLanguageFeaturesProxy = createProxyIdentifier<ExtHostLanguageFeaturesShape>('ExtHostLanguageFeatures');
