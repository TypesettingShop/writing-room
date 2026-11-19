import { Workbench } from './workbench.js';

export function create(container: HTMLElement): void {
  new Workbench(container).startup();
}
