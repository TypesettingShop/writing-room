import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { CommandDto } from './extHost.protocol.treeViews.js';

/** A `ThemeColor` across the wire: its id only. */
export interface ThemeColorDto {
  readonly id: string;
}

export interface StatusBarEntryDto {
  readonly text: string;
  readonly name?: string;
  /** The id the extension gave `createStatusBarItem`; the element is then "<extension id>.<id>". */
  readonly id?: string;
  readonly tooltip?: string;
  readonly command?: string | CommandDto;
  readonly alignment: 1 | 2;
  readonly priority?: number;
  readonly color?: string | ThemeColorDto;
  readonly backgroundColor?: ThemeColorDto;
  readonly accessibilityInformation?: { readonly label: string; readonly role?: string };
}

export interface MainThreadStatusBarShape {
  $setEntry(extension: string, id: string, entry: StatusBarEntryDto): Promise<void>;
  $disposeEntry(extension: string, id: string): Promise<void>;
}

export const MainThreadStatusBarProxy = createProxyIdentifier<MainThreadStatusBarShape>('MainThreadStatusBar');
