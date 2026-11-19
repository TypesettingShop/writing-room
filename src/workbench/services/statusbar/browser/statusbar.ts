import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

export const IStatusbarService = createDecorator<IStatusbarService>('statusbarService');

export enum StatusbarAlignment {
  LEFT,
  RIGHT,
}

export interface IStatusbarEntry {
  readonly name: string;
  readonly text: string;
  /** The accessible name; without one it is `name`. */
  readonly ariaLabel?: string;
  /** The ARIA role of the item: lower-case words, as `accessibilityInformation.role` gives one. */
  readonly role?: string;
  readonly tooltip?: string;
  readonly command?: string | { readonly id: string; readonly arguments?: readonly unknown[] };
  /** The text color: a hex color, or a theme color by id, which follows the theme. Anything else is ignored. */
  readonly color?: string | { readonly id: string };
  /**
   * A theme color by id for the background. Only the ids of `STATUS_BAR_ITEM_BACKGROUNDS` apply, and the
   * text then takes the foreground that goes with the background, whatever `color` says.
   */
  readonly backgroundColor?: { readonly id: string };
}

/** The backgrounds an item may have, each with the foreground that goes with it (VS Code's `ALLOWED_BACKGROUND_COLORS`). */
export const STATUS_BAR_ITEM_BACKGROUNDS: ReadonlyMap<string, string> = new Map([
  ['statusBarItem.errorBackground', 'statusBarItem.errorForeground'],
  ['statusBarItem.warningBackground', 'statusBarItem.warningForeground'],
]);

export interface IStatusbarEntryAccessor extends IDisposable {
  update(entry: IStatusbarEntry): void;
}

export interface IStatusbarService extends BrandedService {
  addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor;
}
