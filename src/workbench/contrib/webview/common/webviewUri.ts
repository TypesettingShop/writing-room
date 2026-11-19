import { URI } from '../../../../base/common/uri.js';

export const webviewResourcePrefix = '/webview/vscode-resource/';

export function asWebviewUri(origin: string, resource: URI): URI {
  if (resource.hasEncodedPathSeparator) {
    throw new Error('A Webview resource URI cannot contain an encoded path separator.');
  }
  const path = resource.path.split('/').map(encodeURIComponent).join('/');
  return URI.parse(origin + webviewResourcePrefix + encodeURIComponent(resource.scheme) + '/'
    + encodeURIComponent(resource.authority) + path
    + (resource.query ? '?' + resource.query : '') + (resource.fragment ? '#' + encodeURIComponent(resource.fragment) : ''));
}
