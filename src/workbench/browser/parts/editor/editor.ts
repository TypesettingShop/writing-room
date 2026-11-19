import { Dimension } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { configurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { ISerializableView } from '../../../../base/browser/ui/grid/grid.js';
import type { IEditorGroupModelOptions, ISerializedEditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import type { GroupIdentifier } from '../../../common/editor.js';
import type { GroupDirection, IEditorGroup, IMergeGroupOptions } from '../../../services/editor/common/editorGroupsService.js';

/** The smallest an editor group, and so an editor pane, may be. */
export const DEFAULT_EDITOR_MIN_DIMENSIONS = new Dimension(220, 70);

/** The largest an editor group may be. */
export const DEFAULT_EDITOR_MAX_DIMENSIONS = new Dimension(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);

/** The model's options (`openPositioning`, `focusRecentEditorAfterClose`) and the part's own. */
export interface IEditorPartOptions extends IEditorGroupModelOptions {
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

export const closeEmptyGroupsSetting = 'workbench.editor.closeEmptyGroups';
configurationRegistry.registerConfiguration({
  id: 'workbench.editor',
  title: 'Editor Groups',
  properties: {
    [closeEmptyGroupsSetting]: {
      type: 'boolean', default: DEFAULT_EDITOR_PART_OPTIONS.closeEmptyGroups,
      description: 'Closes an editor group when its last editor closes.',
    },
  },
});

/** The providers set and not yet disposed, the latest last: it is the one in use. */
const optionsProviders: { readonly provide: () => Partial<IEditorPartOptions> }[] = [];

/**
 * The editor part's options, read afresh on every use. VS Code reads them from the configuration;
 * here a provider fills them in over the defaults, so the settings member can feed configuration
 * values in without the editor part knowing where they come from.
 */
export function getEditorPartOptions(): IEditorPartOptions {
  // A value the provider leaves `undefined` keeps its default.
  const provided = Object.entries(optionsProviders.at(-1)?.provide() ?? {}).filter(([, value]) => value !== undefined);
  return { ...DEFAULT_EDITOR_PART_OPTIONS, ...Object.fromEntries(provided) };
}

/**
 * Puts `provider` in front of the defaults until the returned disposable is disposed. Disposing it
 * takes this provider out wherever it is, so the providers can be disposed in any order and a
 * disposed one never comes back.
 */
export function setEditorPartOptionsProvider(provider: () => Partial<IEditorPartOptions>): IDisposable {
  const entry = { provide: provider };
  optionsProviders.push(entry);
  return toDisposable(() => {
    const index = optionsProviders.indexOf(entry);
    if (index !== -1) {
      optionsProviders.splice(index, 1);
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

  // What a drop onto a group's tabs or body does.
  getGroup(identifier: GroupIdentifier): IEditorGroupView | undefined;
  addGroup(location: IEditorGroupView, direction: GroupDirection): IEditorGroupView;
  moveGroup(group: IEditorGroupView, location: IEditorGroupView, direction: GroupDirection): IEditorGroupView;
  mergeGroup(group: IEditorGroupView, target: IEditorGroupView, options?: IMergeGroupOptions): boolean;
}

/**
 * Merges a dragged group into `target` (at `index`, or after its editors) and keeps the editor that
 * was active in the dragged group active in `target`, as a drop of a whole group does.
 */
export function mergeDroppedGroup(groupsView: IEditorGroupsView, source: IEditorGroupView, target: IEditorGroupView, index?: number): void {
  const active = source.activeEditor;
  groupsView.mergeGroup(source, target, { index });
  if (active && target.contains(active)) {
    void target.openEditor(active);
  }
}

/** An editor group as the part and the other groups see it: a group that is also a grid view. */
export interface IEditorGroupView extends IEditorGroup, ISerializableView {
  readonly disposed: boolean;
  /** The tab strip area at the top of the group; the drop overlay covers what lies below it. */
  readonly titleContainer: HTMLElement;
  /** The height of `titleContainer`, which drop coordinates leave out. */
  readonly titleHeight: number;
  /** Marks the group as the active one, or not. Only the part calls this. */
  setActive(active: boolean): void;
  toJSON(): ISerializedEditorGroupModel;
  dispose(): void;
}
