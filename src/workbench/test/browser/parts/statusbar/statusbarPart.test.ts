import { afterEach, beforeEach, expect, test } from 'vitest';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { StatusbarPart, statusbarEntryColors } from '../../../../browser/parts/statusbar/statusbarPart.js';
import { StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import type { IStatusbarEntry } from '../../../../services/statusbar/browser/statusbar.js';

let part: StatusbarPart;
let container: HTMLElement;

beforeEach(() => {
  part = new StatusbarPart({ executeCommand: async () => undefined } as unknown as ICommandService);
  container = document.createElement('footer');
  document.body.append(container);
  part.create(container);
});

afterEach(() => {
  part.dispose();
  container.remove();
});

function add(entry: Partial<IStatusbarEntry>, id = 'test.item'): { label: HTMLElement; update(entry: Partial<IStatusbarEntry>): void } {
  const accessor = part.addEntry({ name: 'Item', text: 'text', ...entry }, id, StatusbarAlignment.LEFT, 0);
  const label = () => container.querySelector<HTMLElement>(`[data-entry-id="${id}"] > *`)!;
  return {
    get label() { return label(); },
    update: next => accessor.update({ name: 'Item', text: 'text', ...next }),
  };
}

test('a hex text color applies; any other string does not reach the style', () => {
  const item = add({ color: '#abc' });
  expect(item.label.style.color).toBe('rgb(170, 187, 204)');
  for (const color of ['red', 'red; background: url(x)', 'url(https://example.test/x.png)', 'rgb(1, 2, 3)', '#abcde', 'var(--vscode-foreground)']) {
    item.update({ color });
    expect(item.label.style.color, color).toBe('');
    expect(item.label.getAttribute('style') ?? '', color).not.toMatch(/url|background|rgb\(1|var/);
  }
});

test('a theme color is its variable, so it follows the theme; an id that is not a color id is ignored', () => {
  expect(statusbarEntryColors({ color: { id: 'charts.red' } })).toEqual({ color: 'var(--vscode-charts-red)', background: '' });
  expect(statusbarEntryColors({ color: { id: 'x); background: url(y' } })).toEqual({ color: '', background: '' });
  expect(statusbarEntryColors({ color: { id: 'a-b' } })).toEqual({ color: '', background: '' });
  const item = add({ color: { id: 'charts.red' } });
  expect(item.label.style.getPropertyValue('color')).toBe('var(--vscode-charts-red)');
});

test('only the error and warning backgrounds apply, each with its own foreground over the given color', () => {
  expect(statusbarEntryColors({ color: '#ffffff', backgroundColor: { id: 'statusBarItem.errorBackground' } })).toEqual({
    color: 'var(--vscode-statusBarItem-errorForeground)', background: 'var(--vscode-statusBarItem-errorBackground)',
  });
  expect(statusbarEntryColors({ backgroundColor: { id: 'statusBarItem.warningBackground' } })).toEqual({
    color: 'var(--vscode-statusBarItem-warningForeground)', background: 'var(--vscode-statusBarItem-warningBackground)',
  });
  for (const id of ['editor.background', 'statusBarItem.prominentBackground', 'charts.red']) {
    expect(statusbarEntryColors({ color: '#123456', backgroundColor: { id } }), id).toEqual({ color: '#123456', background: '' });
  }
  const item = add({ backgroundColor: { id: 'statusBarItem.errorBackground' } });
  expect(item.label.style.getPropertyValue('background-color')).toBe('var(--vscode-statusBarItem-errorBackground)');
  item.update({ backgroundColor: { id: 'editor.background' } });
  expect(item.label.style.getPropertyValue('background-color')).toBe('');
  expect(item.label.style.getPropertyValue('color')).toBe('');
});

test('the accessible name is the accessibility label, else the name; a role is set only when it is a role', () => {
  const item = add({ ariaLabel: 'Build failed, 3 errors', role: 'link' });
  expect(item.label.getAttribute('aria-label')).toBe('Build failed, 3 errors');
  expect(item.label.getAttribute('role')).toBe('link');
  item.update({ role: 'link" onclick="x' });
  expect(item.label.getAttribute('aria-label')).toBe('Item');
  expect(item.label.hasAttribute('role')).toBe(false);
});

test('a tooltip is plain text in the title, never markup', () => {
  const tooltip = '**bold** <img src=x onerror="alert(1)">';
  const item = add({ tooltip });
  expect(item.label.title).toBe(tooltip);
  expect(container.querySelector('img')).toBeNull();
});
