// @vitest-environment node
import { afterEach, expect, test } from 'vitest';
import { Emitter } from '../../../../base/common/event.js';
import { ColorScheme } from '../../../../platform/theme/common/themeService.js';
import type { IColorTheme, IThemeService } from '../../../../platform/theme/common/themeService.js';
import { colorThemeKind, MainThreadTheming } from '../../browser/mainThreadTheming.js';
import { ColorThemeKind, ExtHostTheming } from '../../common/extHostTheming.js';
import { ExtHostThemingProxy, MainThreadThemingProxy } from '../../common/extHost.protocol.theming.js';
import { createTestRpcPair } from '../common/testExtensionHost.js';

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

class Themes {
  private readonly changed = new Emitter<IColorTheme>();
  readonly service: IThemeService;
  current: IColorTheme;

  constructor(type: ColorScheme) {
    this.current = this.theme(type);
    this.service = {
      _serviceBrand: undefined, getColorTheme: () => this.current, onDidColorThemeChange: this.changed.event,
    } as IThemeService;
  }

  theme(type: ColorScheme): IColorTheme {
    return { id: type, label: type, type, getColor: () => undefined, defines: () => false, tokenColors: [], semanticHighlighting: false };
  }

  set(type: ColorScheme): void {
    this.current = this.theme(type);
    this.changed.fire(this.current);
  }
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.forEach(dispose => dispose());
  cleanup = [];
});

function connect(themes: Themes) {
  const pair = createTestRpcPair();
  const main = new MainThreadTheming(pair.main.getProxy(ExtHostThemingProxy), themes.service);
  pair.main.set(MainThreadThemingProxy, main);
  const host = new ExtHostTheming(pair.worker.getProxy(MainThreadThemingProxy));
  pair.worker.set(ExtHostThemingProxy, host);
  cleanup.push(() => { host.dispose(); main.dispose(); pair.dispose(); });
  return { main, host };
}

test('each kind of theme maps to its ColorThemeKind', () => {
  const themes = new Themes(ColorScheme.DARK);
  expect([ColorScheme.LIGHT, ColorScheme.DARK, ColorScheme.HIGH_CONTRAST_DARK, ColorScheme.HIGH_CONTRAST_LIGHT]
    .map(type => colorThemeKind(themes.theme(type)))).toEqual([
    ColorThemeKind.Light, ColorThemeKind.Dark, ColorThemeKind.HighContrast, ColorThemeKind.HighContrastLight,
  ]);
});

test('the kind is there before activation, and every change of theme fires once with the new kind', async () => {
  const themes = new Themes(ColorScheme.HIGH_CONTRAST_LIGHT);
  const { host } = connect(themes);
  await host.ready;
  expect(host.activeColorTheme.kind).toBe(ColorThemeKind.HighContrastLight);

  const seen: number[] = [];
  host.onDidChangeActiveColorTheme('a')(theme => seen.push(theme.kind));
  themes.set(ColorScheme.LIGHT);
  await flush();
  expect(seen).toEqual([ColorThemeKind.Light]);
  expect(host.activeColorTheme.kind).toBe(ColorThemeKind.Light);
  // Another theme of the same kind is still a change of theme.
  themes.set(ColorScheme.LIGHT);
  themes.set(ColorScheme.HIGH_CONTRAST_DARK);
  await flush();
  expect(seen).toEqual([ColorThemeKind.Light, ColorThemeKind.Light, ColorThemeKind.HighContrast]);
  expect(Object.isFrozen(host.activeColorTheme)).toBe(true);
});

test('a released extension gets no more events, others still do; a disposed main thread sends none', async () => {
  const themes = new Themes(ColorScheme.DARK);
  const { host, main } = connect(themes);
  await host.ready;
  const a: number[] = [];
  const b: number[] = [];
  host.onDidChangeActiveColorTheme('a')(theme => a.push(theme.kind));
  host.onDidChangeActiveColorTheme('b')(theme => b.push(theme.kind));
  host.release('a');
  themes.set(ColorScheme.LIGHT);
  await flush();
  expect(a).toEqual([]);
  expect(b).toEqual([ColorThemeKind.Light]);
  // Activated again, the extension listens again.
  host.onDidChangeActiveColorTheme('a')(theme => a.push(theme.kind));
  main.dispose();
  themes.set(ColorScheme.DARK);
  await flush();
  expect(a).toEqual([]);
  expect(b).toEqual([ColorThemeKind.Light]);
  expect(host.activeColorTheme.kind).toBe(ColorThemeKind.Light);
});

test('without a workbench answer the theme is dark', async () => {
  const pair = createTestRpcPair();
  cleanup.push(() => pair.dispose());
  const host = new ExtHostTheming(pair.worker.getProxy(MainThreadThemingProxy));
  await host.ready;
  expect(host.activeColorTheme.kind).toBe(ColorThemeKind.Dark);
});
