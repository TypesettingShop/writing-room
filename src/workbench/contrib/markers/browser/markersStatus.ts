import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IMarkerService } from '../../../../platform/markers/common/markers.js';
import { StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntry, IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';

export const PROBLEMS_STATUS_ID = 'status.problems';
export const FOCUS_PROBLEMS_COMMAND = 'workbench.actions.view.problems';

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function problemsEntry(errors: number, warnings: number): IStatusbarEntry {
  const description = `${plural(errors, 'error')}, ${plural(warnings, 'warning')}`;
  return {
    name: 'Problems',
    text: `$(error) ${errors} $(warning) ${warnings}`,
    ariaLabel: description,
    tooltip: description,
    command: FOCUS_PROBLEMS_COMMAND,
  };
}

/** The error and warning counts of the marker service, at the left of the status bar. */
export class ProblemsStatus extends Disposable {
  constructor(private readonly markers: IMarkerService, statusbar: IStatusbarService) {
    super();
    const accessor = this._register(statusbar.addEntry(this.entry(), PROBLEMS_STATUS_ID, StatusbarAlignment.LEFT, 50));
    this._register(markers.onMarkerChanged(() => accessor.update(this.entry())));
  }

  private entry(): IStatusbarEntry {
    const { errors, warnings } = this.markers.getStatistics();
    return problemsEntry(errors, warnings);
  }
}
