import { toDisposable } from '../common/lifecycle.js';
import type { IDisposable } from '../common/lifecycle.js';

export function $<Tag extends keyof HTMLElementTagNameMap>(
  description: Tag,
  attributes?: Record<string, string | number | boolean | null | undefined> | null,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[Tag];
export function $(
  description: string,
  attributes?: Record<string, string | number | boolean | null | undefined> | null,
  ...children: (Node | string)[]
): HTMLElement;
export function $(
  description: string,
  attributes?: Record<string, string | number | boolean | null | undefined> | null,
  ...children: (Node | string)[]
): HTMLElement {
  const match = /^([\w-]+)?((?:[.#][\w-]+)*)$/.exec(description);
  if (!match || !description) {
    throw new Error(`Invalid element description: ${description}`);
  }
  const element = document.createElement(match[1] ?? 'div');
  for (const [, kind, name] of match[2].matchAll(/([.#])([\w-]+)/g)) {
    if (kind === '#') {
      element.id = name;
    } else {
      element.classList.add(name);
    }
  }
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value !== null && value !== undefined) {
      element.setAttribute(name, String(value));
    }
  }
  element.append(...children);
  return element;
}

export function append<T extends Node>(parent: ParentNode, child: T): T;
export function append(parent: ParentNode, ...children: (Node | string)[]): void;
export function append(parent: ParentNode, ...children: (Node | string)[]): Node | void {
  parent.append(...children);
  const [child] = children;
  return children.length === 1 && typeof child !== 'string' ? child : undefined;
}

export function clearNode(node: ParentNode): void {
  node.replaceChildren();
}

type DOMEventMap = HTMLElementEventMap & WindowEventMap & DocumentEventMap;

export function addDisposableListener<K extends keyof DOMEventMap>(
  target: EventTarget,
  type: K,
  listener: (event: DOMEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): IDisposable;
export function addDisposableListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): IDisposable;
export function addDisposableListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): IDisposable {
  const capture = typeof options === 'boolean' ? options : options?.capture;
  target.addEventListener(type, listener, options);
  return toDisposable(() => target.removeEventListener(type, listener, capture));
}

export class Dimension {
  static readonly None = new Dimension(0, 0);

  constructor(readonly width: number, readonly height: number) {}
}
