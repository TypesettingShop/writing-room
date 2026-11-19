import { RawContextKey } from './contextkey.js';

export const InputFocusedContext = new RawContextKey<boolean>('inputFocus', false);

// The platform, as VS Code names it. The workbench runs in a browser, so `isWeb` is always true and the
// other three tell the operating system the browser runs on.
export const IsWebContext = new RawContextKey<boolean>('isWeb', true);
export const IsMacContext = new RawContextKey<boolean>('isMac', false);
export const IsLinuxContext = new RawContextKey<boolean>('isLinux', false);
export const IsWindowsContext = new RawContextKey<boolean>('isWindows', false);
