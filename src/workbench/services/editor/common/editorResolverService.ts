import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput, ITextEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import type { EditorInput } from '../../../common/editor/editorInput.js';
import type { IEditorGroup } from './editorGroupsService.js';

export const IEditorResolverService = createDecorator<IEditorResolverService>('editorResolverService');

/** The setting that maps file name patterns to the editor id that opens them. */
export const EDITOR_ASSOCIATIONS_SETTING = 'workbench.editorAssociations';

/** The id the plain text editor registers under, the fallback when nothing else wants a resource. */
export const DEFAULT_EDITOR_ID = 'default';

export enum RegisteredEditorPriority {
  /** Wins over everything, the user's associations included. */
  exclusive = 'exclusive',
  /** Opens a resource unless an association says otherwise. */
  default = 'default',
  /** A workbench editor; one an extension contributes at `default` wins over it. */
  builtin = 'builtin',
  /** Only when asked for by id or by an association, such as "Reopen With". */
  option = 'option',
}

/** VS Code's ranks, highest first; the text editor sits between `builtin` and `option`. */
export function priorityToRank(priority: RegisteredEditorPriority): number {
  switch (priority) {
    case RegisteredEditorPriority.exclusive: return 5;
    case RegisteredEditorPriority.default: return 4;
    case RegisteredEditorPriority.builtin: return 3;
    case RegisteredEditorPriority.option: return 1;
  }
}

export interface RegisteredEditorInfo {
  /** The editor id: what an override or an association names. */
  readonly id: string;
  /** What "Reopen With" lists. */
  readonly label: string;
  readonly detail?: string;
  readonly priority: RegisteredEditorPriority;
}

export interface RegisteredEditorOptions {
  /** Narrows the glob: the editor takes only the resources this accepts. */
  canSupportResource?(resource: URI): boolean;
}

export interface EditorInputWithOptions {
  readonly editor: EditorInput;
  readonly options?: ITextEditorOptions;
}

export type EditorInputFactoryFunction =
  (input: IResourceEditorInput, group: IEditorGroup) => EditorInputWithOptions | Promise<EditorInputWithOptions>;

export interface IResolvedEditor extends EditorInputWithOptions {
  /** The registration that made the input; `undefined` for the error input of an unopenable resource. */
  readonly editorId: string | undefined;
}

/**
 * Turns a resource into the editor input that opens it. Editors register a glob, who they are and a
 * factory; the resolver picks by priority, the user's associations and an explicit override, as VS
 * Code's does.
 */
export interface IEditorResolverService extends BrandedService {
  registerEditor(
    globPattern: string, editorInfo: RegisteredEditorInfo, options: RegisteredEditorOptions,
    createEditorInput: EditorInputFactoryFunction,
  ): IDisposable;
  /**
   * The input for `input` in `group`. With `options.override` that editor is used whatever its glob
   * says. When no registration takes the resource the result is an input that shows why.
   */
  resolveEditor(input: IResourceEditorInput, group: IEditorGroup): Promise<IResolvedEditor>;
  /** The editors that could open `resource`, best first; every registered editor without one. */
  getEditors(resource?: URI): RegisteredEditorInfo[];
}

const MAX_GLOB_LENGTH = 4096;
const MAX_GLOB_ALTERNATIVES = 100;

type GlobToken =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'any' }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'class'; readonly test: (char: string) => boolean };

// `{a,b}` and a `**` followed by a slash (which may also match nothing) as plain alternatives; `undefined` past the limit.
function expandGlob(pattern: string): string[] | undefined {
  let alternatives = [''];
  for (let index = 0; index < pattern.length;) {
    let options: string[];
    if (pattern[index] === '{') {
      const end = pattern.indexOf('}', index);
      if (end === -1) {
        options = ['{'];
        index++;
      } else {
        options = pattern.slice(index + 1, end).split(',');
        index = end + 1;
      }
    } else if (pattern.startsWith('**/', index)) {
      options = ['', '**/'];
      index += 3;
    } else {
      options = [pattern[index]];
      index++;
    }
    if (options.length > 1) {
      if (alternatives.length * options.length > MAX_GLOB_ALTERNATIVES) {
        return undefined;
      }
      alternatives = alternatives.flatMap(prefix => options.map(option => prefix + option));
    } else {
      alternatives = alternatives.map(prefix => prefix + options[0]);
    }
  }
  return alternatives;
}

function tokenize(pattern: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        tokens.push({ kind: 'globstar' });
      } else {
        tokens.push({ kind: 'star' });
      }
    } else if (char === '?') {
      tokens.push({ kind: 'any' });
    } else if (char === '[' && pattern.indexOf(']', index + 2) !== -1) {
      const end = pattern.indexOf(']', index + 2);
      let body = pattern.slice(index + 1, end).toLowerCase();
      const negated = body[0] === '!' || body[0] === '^';
      body = negated ? body.slice(1) : body;
      const ranges: [string, string][] = [];
      for (let at = 0; at < body.length; at++) {
        if (body[at + 1] === '-' && at + 2 < body.length) {
          ranges.push([body[at], body[at + 2]]);
          at += 2;
        } else {
          ranges.push([body[at], body[at]]);
        }
      }
      const inClass = (c: string) => ranges.some(([from, to]) => c >= from && c <= to);
      tokens.push({ kind: 'class', test: c => c !== '/' && inClass(c) !== negated });
      index = end;
    } else {
      tokens.push({ kind: 'char', char: char.toLowerCase() });
    }
  }
  return tokens;
}

/**
 * Runs the tokens over `text` as a set of states, one step per character, so a match costs the
 * text's length times the pattern's at most, whatever the pattern: no backtracking at all.
 */
function matchTokens(tokens: readonly GlobToken[], text: string): boolean {
  const close = (states: Set<number>) => {
    for (const state of states) {
      const token = tokens[state];
      if (token && (token.kind === 'star' || token.kind === 'globstar')) {
        states.add(state + 1);
      }
    }
    return states;
  };
  let states = close(new Set([0]));
  for (const char of text.toLowerCase()) {
    const next = new Set<number>();
    for (const state of states) {
      const token = tokens[state];
      if (!token) {
        continue;
      }
      switch (token.kind) {
        case 'star': if (char !== '/') { next.add(state); } break;
        case 'globstar': next.add(state); break;
        case 'any': if (char !== '/') { next.add(state + 1); } break;
        case 'char': if (char === token.char) { next.add(state + 1); } break;
        case 'class': if (token.test(char)) { next.add(state + 1); } break;
      }
    }
    if (next.size === 0) {
      return false;
    }
    states = close(next);
  }
  return states.has(tokens.length);
}

const globCache = new Map<string, GlobToken[][] | null>();

/**
 * A glob, matched without case: `**`, `*`, `?`, `{a,b}` and `[...]`/`[!...]`. A pattern longer than
 * 4 KiB, or with more than 100 alternatives, matches nothing. The URI and glob member adds the
 * shared `glob.ts`; this matcher then gives way to it.
 */
function compileGlob(pattern: string): GlobToken[][] | null {
  let compiled = globCache.get(pattern);
  if (compiled === undefined) {
    const alternatives = pattern.length <= MAX_GLOB_LENGTH ? expandGlob(pattern) : undefined;
    compiled = alternatives?.map(tokenize) ?? null;
    globCache.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Whether `globPattern` takes `resource`, as VS Code decides: a pattern with a `/` is matched
 * against `scheme:path`, any other against the file name; case does not matter.
 */
export function globMatchesResource(globPattern: string, resource: URI): boolean {
  const target = globPattern.includes('/') ? `${resource.scheme}:${resource.path}` : basename(resource);
  return compileGlob(globPattern)?.some(tokens => matchTokens(tokens, target)) ?? false;
}
