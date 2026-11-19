import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';
import type { CommandDto } from './extHost.protocol.treeViews.js';

export interface StatusBarEntryDto {
  readonly text: string;
  readonly name?: string;
  readonly tooltip?: string;
  readonly command?: string | CommandDto;
  readonly alignment: 1 | 2;
  readonly priority?: number;
}

export interface MainThreadStatusBarShape {
  $setEntry(extension: string, id: string, entry: StatusBarEntryDto): Promise<void>;
  $disposeEntry(extension: string, id: string): Promise<void>;
}

export const MainThreadStatusBarProxy = createProxyIdentifier<MainThreadStatusBarShape>('MainThreadStatusBar');
