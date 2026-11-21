import type * as vscode from 'vscode';
import { Emitter } from '../../../base/common/event.js';
import { extHostApiRegistry } from './extHostApiRegistry.js';
import { ExtHostThemingProxy, MainThreadThemingProxy } from './extHost.protocol.theming.js';
import type { ColorThemeKindDto, ExtHostThemingShape, MainThreadThemingShape } from './extHost.protocol.theming.js';

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

function isKind(value: unknown): value is ColorThemeKindDto {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function colorTheme(kind: ColorThemeKind): vscode.ColorTheme {
  return Object.freeze({ kind });
}

/**
 * `window.activeColorTheme` and its change event. The kind arrives before any extension activates; until
 * it does, and if the workbench cannot say, the theme is dark, as the default theme is.
 */
export class ExtHostTheming implements ExtHostThemingShape {
  private current = colorTheme(ColorThemeKind.Dark);
  private initialized = false;
  readonly ready: Promise<void>;
  private readonly emitters = new Map<string, Emitter<vscode.ColorTheme>>();

  constructor(proxy: MainThreadThemingShape) {
    this.ready = proxy.$getColorThemeKind().then(kind => {
      if (isKind(kind)) {
        this.current = colorTheme(kind);
      }
      this.initialized = true;
    }, () => {
      this.initialized = true;
    });
  }

  get activeColorTheme(): vscode.ColorTheme {
    return this.current;
  }

  async $onColorThemeChange(kind: ColorThemeKindDto): Promise<void> {
    // The kind requested at start was read after any change sent before it.
    if (!this.initialized || !isKind(kind)) {
      return;
    }
    this.current = colorTheme(kind);
    for (const emitter of [...this.emitters.values()]) {
      emitter.fire(this.current);
    }
  }

  onDidChangeActiveColorTheme(extension: string): vscode.Event<vscode.ColorTheme> {
    let emitter = this.emitters.get(extension);
    if (!emitter) {
      emitter = new Emitter();
      this.emitters.set(extension, emitter);
    }
    return emitter.event;
  }

  /** Stops the events of an extension that was deactivated or removed. */
  release(extension: string): void {
    this.emitters.get(extension)?.dispose();
    this.emitters.delete(extension);
  }

  dispose(): void {
    for (const emitter of this.emitters.values()) {
      emitter.dispose();
    }
    this.emitters.clear();
  }
}

extHostApiRegistry.register('theming', ({ rpc }) => {
  const theming = new ExtHostTheming(rpc.getProxy(MainThreadThemingProxy));
  rpc.set(ExtHostThemingProxy, theming);
  return {
    service: theming,
    ready: theming.ready,
    create: ({ key }) => ({
      types: { ColorThemeKind },
      namespaces: {
        window: {
          get activeColorTheme() { return theming.activeColorTheme; },
          // Looked up on each call: a released extension that is activated again gets events again.
          onDidChangeActiveColorTheme: (listener, thisArgs?, disposables?) =>
            theming.onDidChangeActiveColorTheme(key)(listener, thisArgs, disposables),
        } satisfies Pick<typeof vscode.window, 'activeColorTheme' | 'onDidChangeActiveColorTheme'>,
      },
    }),
    release: key => theming.release(key),
    dispose: () => theming.dispose(),
  };
});
