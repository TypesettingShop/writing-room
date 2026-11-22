import { isManuscriptId } from '../../../../platform/manuscript/common/manuscript.js';

export function readManuscriptWindowWorkId(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll('work');
  return values.length === 1 && isManuscriptId(values[0]) ? values[0] : undefined;
}
