import { Dimension } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { ISerializableView } from '../../../../base/browser/ui/grid/grid.js';
import type { ISerializedEditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import type { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

/** The smallest an editor group, and so an editor pane, may be. */
export const DEFAULT_EDITOR_MIN_DIMENSIONS = new Dimension(220, 70);

/** The largest an editor group may be. */
export const DEFAULT_EDITOR_MAX_DIMENSIONS = new Dimension(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

export interface IEditorPartOptions {
  /** Where a new editor opens in its group, relative to the active editor. */
  readonly openPositioning: 'left' | 'right' | 'first' | 'last';
  /** Closing the active editor activates the most recently used one rather than its neighbour. */
  readonly focusRecentEditorAfterClose: boolean;
  /** A group whose last editor closes is removed while other groups are left. */
  readonly closeEmptyGroups: boolean;
  /** How a new group takes its space from the group it splits. */
  readonly splitSizing: 'auto' | 'distribute' | 'split';
}

export const DEFAULT_EDITOR_PART_OPTIONS: IEditorPartOptions = {
  openPositioning: 'right',
  focusRecentEditorAfterClose: true,
  closeEmptyGroups: true,
  splitSizing: 'auto',
};

let optionsProvider: (() => Partial<IEditorPartOptions>) | undefined;

/**
 * The editor part's options, read afresh on every use. VS Code reads them from the configuration;
 * here a provider fills them in over the defaults, so the settings member can feed configuration
 * values in without the editor part knowing where they come from.
 */
export function getEditorPartOptions(): IEditorPartOptions {
  // A value the provider leaves `undefined` keeps its default.
  const provided = Object.entries(optionsProvider?.() ?? {}).filter(([, value]) => value !== undefined);
  return { ...DEFAULT_EDITOR_PART_OPTIONS, ...Object.fromEntries(provided) };
}

/** Puts `provider` in front of the defaults until the returned disposable is disposed. */
export function setEditorPartOptionsProvider(provider: () => Partial<IEditorPartOptions>): IDisposable {
  const previous = optionsProvider;
  optionsProvider = provider;
  return toDisposable(() => {
    if (optionsProvider === provider) {
      optionsProvider = previous;
    }
  });
}

/** What a group sees of the part that holds it. */
export interface IEditorGroupsView {
  readonly groups: readonly IEditorGroupView[];
  readonly activeGroup: IEditorGroupView;
  readonly count: number;
  readonly partOptions: IEditorPartOptions;

  activateGroup(group: IEditorGroupView): void;
  removeGroup(group: IEditorGroupView, preserveFocus?: boolean): void;
}

/** An editor group as the part and the other groups see it: a group that is also a grid view. */
export interface IEditorGroupView extends IEditorGroup, ISerializableView {
  readonly disposed: boolean;
  /** Marks the group as the active one, or not. Only the part calls this. */
  setActive(active: boolean): void;
  toJSON(): ISerializedEditorGroupModel;
  dispose(): void;
}
