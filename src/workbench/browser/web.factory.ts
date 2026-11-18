import { $, append } from '../../base/browser/dom.js';
import { renderLabelWithIcons } from '../../base/browser/ui/iconLabel/iconLabels.js';

export function create(container: HTMLElement): void {
  append(container, $('main.workbench', null, ...renderLabelWithIcons('$(edit) Writing Room')));
}
