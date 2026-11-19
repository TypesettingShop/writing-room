import { expect, it, vi } from 'vitest';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileType } from '../../../../../platform/files/common/files.js';
import type { IFileContent } from '../../../../../platform/files/common/files.js';
import { ColorScheme, DefaultThemeService } from '../../../../../platform/theme/common/themeService.js';
import type { IColorTheme, IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { EditorTabIcon } from '../../../../browser/parts/editor/editorTabIcon.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';

it('selects light and dark images, aborts obsolete reads and revokes the displayed URLs', async () => {
  const light = URI.parse('https://example.test/ext/light.png');
  const dark = URI.parse('https://example.test/ext/dark.png');
  class Input extends EditorInput {
    readonly typeId = 'test.tabIcon';
    readonly resource = undefined;
    override getTabIcon() { return { light, dark }; }
  }
  const editor = new Input();
  const label = document.createElement('span');
  const themeChanged = new Emitter<IColorTheme>();
  let theme = new DefaultThemeService().getColorTheme();
  const themes: IThemeService = {
    _serviceBrand: undefined, getColorTheme: () => theme, onDidColorThemeChange: themeChanged.event,
  };
  const setTheme = (type: ColorScheme) => {
    theme = { ...theme, type };
    themeChanged.fire(theme);
  };
  let finishDark!: (value: IFileContent) => void;
  const file = (resource: URI): IFileContent => ({
    resource, name: 'icon.png', ctime: 0, mtime: 0, etag: '', size: 1, value: new Uint8Array([1]),
    type: FileType.File, isFile: true, isDirectory: false, isSymbolicLink: false, readonly: true,
  });
  const files = new FileService();
  const readFile = vi.spyOn(files, 'readFile')
    .mockImplementationOnce(() => new Promise(resolve => { finishDark = resolve; }))
    .mockImplementation(async resource => file(resource));
  const createObjectURL = vi.fn().mockReturnValueOnce('blob:light').mockReturnValueOnce('blob:dark');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  const icon = new EditorTabIcon(label, editor, files, themes);

  try {
    const firstRead = readFile.mock.calls[0];
    expect(firstRead[0]).toEqual(dark);
    expect(firstRead[1]?.limits?.size).toBe(256 * 1024);
    setTheme(ColorScheme.LIGHT);
    expect(firstRead[1]?.signal?.aborted).toBe(true);
    expect(readFile.mock.calls[1][0]).toEqual(light);
    await vi.waitFor(() => expect(label.querySelector('img')?.getAttribute('src')).toBe('blob:light'));
    finishDark(file(dark));
    await Promise.resolve();
    expect(createObjectURL).toHaveBeenCalledOnce();

    setTheme(ColorScheme.HIGH_CONTRAST_LIGHT);
    expect(readFile).toHaveBeenCalledTimes(2);
    setTheme(ColorScheme.HIGH_CONTRAST_DARK);
    expect(readFile.mock.calls[2][0]).toEqual(dark);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:light');
    await vi.waitFor(() => expect(label.querySelector('img')?.getAttribute('src')).toBe('blob:dark'));

    icon.dispose();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:light'], ['blob:dark']]);
  } finally {
    icon.dispose();
    editor.dispose();
    themeChanged.dispose();
    files.dispose();
    vi.unstubAllGlobals();
  }
});
