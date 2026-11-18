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
  readonly ariaLabel?: string;
  readonly tooltip?: string;
  readonly command?: string | { readonly id: string; readonly arguments?: readonly unknown[] };
}

export interface IStatusbarEntryAccessor extends IDisposable {
  update(entry: IStatusbarEntry): void;
}

export interface IStatusbarService extends BrandedService {
  addEntry(entry: IStatusbarEntry, id: string, alignment: StatusbarAlignment, priority: number): IStatusbarEntryAccessor;
}
