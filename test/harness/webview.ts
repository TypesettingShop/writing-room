import { URI } from '../../src/base/common/uri.js';
import { FileService } from '../../src/platform/files/common/fileService.js';
import { DefaultThemeService } from '../../src/platform/theme/common/themeService.js';
import { FetchFileSystemProvider } from '../../src/workbench/services/extensions/browser/webWorkerFileSystemProvider.js';
import { asWebviewUri } from '../../src/workbench/contrib/webview/browser/resourceLoading.js';
import { WebviewElement } from '../../src/workbench/contrib/webview/browser/webviewElement.js';
import { getWebviewForwardingPorts, resolveWebviewOrigin } from '../../src/workbench/contrib/webview/browser/webviewOrigin.js';

const page = new URL(location.href);
const template = page.searchParams.get('template') ?? undefined;
const origin = resolveWebviewOrigin(page, template, undefined, await getWebviewForwardingPorts(page, template));
const files = new FileService();
files.registerProvider('http', new FetchFileSystemProvider());
const links: string[] = [];
const messages: unknown[] = [];
const element = new WebviewElement(document, origin, files, {
  _serviceBrand: undefined,
  registerOpener: () => ({ dispose() {} }),
  open: async value => { links.push(value.toString()); return true; },
}, new DefaultThemeService());
element.onDidReceiveMessage(message => messages.push(message));
document.body.append(element.container);
Object.assign(window, {
  harness: {
    messages, links, dispose: () => element.dispose(),
    send: (value: unknown) => element.postMessage(value),
    state: element.onDidChangeState,
    set: (html: string, scripts: boolean, root?: string) => element.setContent(html, {
      enableScripts: scripts, localResourceRoots: root ? [URI.parse(root)] : undefined,
    }),
    asWebviewUri: (value: string) => 'origin' in origin ? asWebviewUri(origin.origin, URI.parse(value)).toString(true) : '',
  },
});
