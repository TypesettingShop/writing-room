import { GroupDirection, GroupsOrder } from './editorGroupsService.js';
import type { IEditorGroup, IEditorGroupsService } from './editorGroupsService.js';
import { ACTIVE_GROUP, SIDE_GROUP } from './editorService.js';
import type { ACTIVE_GROUP_TYPE, SIDE_GROUP_TYPE } from './editorService.js';
import type { GroupIdentifier } from '../../../common/editor.js';

/**
 * A group addressed by its place on screen, `0` for the first group in grid order, as VS Code's
 * `EditorGroupColumn` is. The API's `ViewColumn.One` is column `0`; `ACTIVE_GROUP` and `SIDE_GROUP`
 * stand for `ViewColumn.Active` and `ViewColumn.Beside`.
 */
export type EditorGroupColumn = number;

/** The most columns there can be, as `ViewColumn` has nine. */
const MAX_COLUMNS = 9;

/**
 * The group of `column`. A column past the last group (up to the ninth) adds one group to the
 * right of the last one and gives that; anything else that names no group opens beside the active one.
 */
export function columnToEditorGroup(
  groups: IEditorGroupsService, column: EditorGroupColumn | ACTIVE_GROUP_TYPE | SIDE_GROUP_TYPE = ACTIVE_GROUP,
): GroupIdentifier | ACTIVE_GROUP_TYPE | SIDE_GROUP_TYPE {
  if (column === ACTIVE_GROUP || column === SIDE_GROUP) {
    return column;
  }
  if (!Number.isInteger(column) || column < 0 || column >= MAX_COLUMNS) {
    return SIDE_GROUP;
  }
  const inOrder = groups.getGroups(GroupsOrder.GRID_APPEARANCE);
  return (inOrder[column] ?? groups.addGroup(inOrder[inOrder.length - 1], GroupDirection.RIGHT)).id;
}

/** The column `group` is in now, `0` first; an id that names no group counts as the active group, a removed group object as `-1`. */
export function editorGroupToColumn(groups: IEditorGroupsService, group: IEditorGroup | GroupIdentifier): EditorGroupColumn {
  const found = typeof group === 'number' ? groups.getGroup(group) : group;
  return groups.getGroups(GroupsOrder.GRID_APPEARANCE).indexOf(found ?? groups.activeGroup);
}
