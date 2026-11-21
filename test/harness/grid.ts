import { $ } from '../../src/base/browser/dom.js';
import { Direction, Grid, Sizing } from '../../src/base/browser/ui/grid/grid.js';
import type { IView, IViewSize } from '../../src/base/browser/ui/grid/grid.js';
import { Emitter } from '../../src/base/common/event.js';

/** A coloured view that shows its own size, named for the browser spec by its region label. */
class HarnessView implements IView {
  readonly element: HTMLElement;
  private readonly _onDidChange = new Emitter<IViewSize | undefined>();
  readonly onDidChange = this._onDidChange.event;
  readonly maximumWidth = Number.POSITIVE_INFINITY;
  readonly maximumHeight = Number.POSITIVE_INFINITY;

  constructor(
    readonly name: string,
    color: string,
    readonly minimumWidth: number,
    readonly minimumHeight: number,
  ) {
    this.element = $('section.harness-view', { role: 'region', 'aria-label': `View ${name}` });
    this.element.style.background = color;
  }

  layout(width: number, height: number, top: number, left: number): void {
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.element.textContent = `${this.name}: ${width} x ${height} at ${left}, ${top}`;
  }
}

const header = document.querySelector('header')!;
const main = document.querySelector('main')!;
const toolbarHeight = 40;

const a = new HarnessView('A', '#264f78', 100, 60);
const b = new HarnessView('B', '#4d3a1f', 120, 80);
const c = new HarnessView('C', '#2d4a2d', 120, 80);
const grid = new Grid<HarnessView>(a, { proportionalLayout: false, styles: { separatorBorder: '#ffffff' } });
main.append(grid.element);

function layout(): void {
  grid.layout(window.innerWidth, window.innerHeight - toolbarHeight);
}

layout();
grid.addView(b, Math.round(window.innerWidth / 2), a, Direction.Right);
grid.addView(c, Sizing.Split, b, Direction.Down);
window.addEventListener('resize', layout);

let added = 0;
const buttons: [string, () => void][] = [
  ['Toggle C', () => grid.setViewVisible(c, !grid.isViewVisible(c))],
  ['Add view', () => {
    const view = new HarnessView(`N${++added}`, '#5a2d4a', 80, 60);
    grid.addView(view, Sizing.Split, a, Direction.Down);
  }],
  ['Distribute', () => grid.distributeViewSizes()],
];
for (const [label, action] of buttons) {
  const button = $('button', { type: 'button' }, label);
  button.addEventListener('click', action);
  header.append(button);
}
