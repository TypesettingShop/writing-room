import { expect, test } from 'vitest';
import { ColorScheme, DefaultThemeService } from '../../../../platform/theme/common/themeService.js';
import { cssString, decorationCss, themedDecoration } from '../../browser/mainThreadEditorDecorationStyles.js';

test('only validated decoration values enter stylesheet rules', () => {
  const theme = new DefaultThemeService().getColorTheme();
  expect(decorationCss({
    backgroundColor: 'red; } body { display: none',
    color: 'url(https://example.test/image)',
    borderColor: { id: 'editor.foreground' },
    border: '1px solid #cafe00',
    fontStyle: 'italic/*',
    letterSpacing: '0.2em',
    margin: '2px 0 2px 3px',
  }, theme, true)).toBe('border-color:#d7dfec;letter-spacing:0.2em;border:1px solid #cafe00;margin:2px 0 2px 3px');
  expect(cssString('"; }body{\n')).toBe('"\\22 ; }body{\\a "');
});

test('theme-specific attachment properties and colors are resolved together', () => {
  const original = new DefaultThemeService().getColorTheme();
  const light = { ...original, type: ColorScheme.LIGHT, getColor: () => '#abcdef' };
  const options = themedDecoration({
    color: { id: 'editor.foreground' },
    before: { contentText: 'prefix', margin: '1px' },
    light: { before: { color: { id: 'editor.foreground' } } },
  }, light);
  expect(options.before).toEqual({ contentText: 'prefix', margin: '1px', color: { id: 'editor.foreground' } });
  expect(decorationCss(options, light)).toBe('color:#abcdef');
});
