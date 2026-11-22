import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { BrandedService } from '../../../../platform/instantiation/common/instantiation.js';

export const IWorkService = createDecorator<IWorkService>('workService');
export const WorkOpenContext = new RawContextKey<boolean>('workOpen', false);

export interface WindowWork {
  readonly id: string;
}

export interface IWorkService extends BrandedService {
  /** The work selected by the URL at startup, fixed for the lifetime of the window. */
  readonly current: WindowWork | undefined;
}

// Use the shared manuscript ID validator once the manuscript storage contract is available.
const manuscriptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readWindowWork(location: Pick<Location, 'search'>): WindowWork | undefined {
  const values = new URLSearchParams(location.search).getAll('work');
  const [id] = values;
  if (values.length === 1 && id.length === 36 && manuscriptId.test(id)) {
    return Object.freeze({ id });
  }
  return undefined;
}
