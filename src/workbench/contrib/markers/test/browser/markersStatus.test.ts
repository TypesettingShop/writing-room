import { afterEach, beforeEach, expect, test } from 'vitest';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import type { IStatusbarEntry, IStatusbarService } from '../../../../services/statusbar/browser/statusbar.js';
import { ProblemsStatus } from '../../browser/markersStatus.js';

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
const data = (severity: MarkerSeverity) => ({ message: 'm', severity, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 });
let disposables: DisposableStore;

beforeEach(() => { disposables = new DisposableStore(); });
afterEach(() => disposables.dispose());

test('shows the counts of the marker service, left, and reads them out in words', async () => {
  const markers = disposables.add(new MarkerService());
  const added: unknown[][] = [];
  let entry!: IStatusbarEntry;
  const statusbar = {
    addEntry(value: IStatusbarEntry, ...rest: unknown[]) {
      entry = value;
      added.push(rest);
      return { update: (next: IStatusbarEntry) => { entry = next; }, dispose() {} };
    },
  } as unknown as IStatusbarService;
  disposables.add(new ProblemsStatus(markers, statusbar));
  expect(added).toEqual([['status.problems', 0, 50]]);
  expect(entry).toMatchObject({ name: 'Problems', text: '$(error) 0 $(warning) 0', ariaLabel: '0 errors, 0 warnings', command: 'workbench.actions.view.problems' });

  markers.changeOne('o', URI.parse('untitled:A'), [data(MarkerSeverity.Error), data(MarkerSeverity.Error), data(MarkerSeverity.Warning), data(MarkerSeverity.Info)]);
  await tick();
  expect(entry.text).toBe('$(error) 2 $(warning) 1');
  expect(entry.ariaLabel).toBe('2 errors, 1 warning');
  const { errors, warnings } = markers.getStatistics();
  expect(entry.text).toBe(`$(error) ${errors} $(warning) ${warnings}`);

  markers.changeOne('o', URI.parse('untitled:A'), [data(MarkerSeverity.Error)]);
  await tick();
  expect(entry.ariaLabel).toBe('1 error, 0 warnings');
});
