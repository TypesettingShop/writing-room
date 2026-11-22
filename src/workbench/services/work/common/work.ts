import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';
import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';

export const IWorkService = createDecorator<IWorkService>('workService');
export const WorkOpenContext = new RawContextKey<boolean>('workOpen', false);

export interface WindowWork {
  readonly id: string;
}

export interface IWorkService extends BrandedService {
  /** The work selected by the URL at startup, fixed for the lifetime of the window. */
  readonly current: WindowWork | undefined;
  open(id: string): Promise<void>;
  close(): Promise<void>;
}

export function readWindowWork(location: Pick<Location, 'search'>): WindowWork | undefined {
  const values = new URLSearchParams(location.search).getAll('work');
  const [id] = values;
  if (values.length === 1 && isManuscriptId(id)) {
    return Object.freeze({ id });
  }
  return undefined;
}
