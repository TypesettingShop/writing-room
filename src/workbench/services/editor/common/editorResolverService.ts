import { parse } from '../../../../base/common/glob.js';
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

/** Patterns come from registrations and the user's associations; past this many the cache starts over. */
const GLOB_CACHE_LIMIT = 500;
const globCache = new Map<string, ((path: string) => boolean) | null>();

/**
 * The shared glob matcher (`base/common/glob.ts`) for a pattern already in lower case. A pattern it
 * refuses (longer than 4 KiB, more than 100 alternatives) matches nothing.
 */
function compileGlob(pattern: string): ((path: string) => boolean) | null {
  let compiled = globCache.get(pattern);
  if (compiled === undefined) {
    try {
      compiled = parse(pattern);
    } catch {
      compiled = null;
    }
    if (globCache.size >= GLOB_CACHE_LIMIT) {
      globCache.clear();
    }
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
  return compileGlob(globPattern.toLowerCase())?.(target.toLowerCase()) ?? false;
}
