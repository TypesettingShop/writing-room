import { describe, expect, it, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { FileSystemProviderError, FileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { asWebviewUri, loadWebviewResource } from '../../browser/resourceLoading.js';

const root = URI.parse('https://example.test:5173/extension/media');
const origin = 'https://webview.example.net';
const signal = new AbortController().signal;

describe('Webview resource authorization', () => {
  it('decodes a resource, reads under its root with a size limit and chooses the MIME from its name', async () => {
    const uri = asWebviewUri(origin, URI.parse(root.toString() + '/app.js'));
    const readFile = vi.fn(async () => ({ value: new Uint8Array([1]) }));
    const files = { readFile } as unknown as IFileService;
    const result = await loadWebviewResource(files, new URL(uri.toString()).pathname, [root], signal);
    expect(readFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/extension/media/app.js' }), {
      limits: { size: 50 * 1024 * 1024 }, signal,
    });
    expect(result).toEqual({ status: 200, mime: 'text/javascript', bytes: new Uint8Array([1]) });
  });

  it.each([
    'https/example.test%3A5173/extension/media-private/app.js',
    'https/example.test%3A5173/extension/media/../secret.js',
    'https/example.test%3A5173/extension/media/%2e%2e/secret.js',
    'https/example.test%3A5173/extension/media/%252e%252e/secret.js',
    'https/example.test%3A5173/extension/media/a%2fb.js',
    'https/example.test%3A5173/extension/media/a%255cb.js',
    'https/wrong.example%3A5173/extension/media/app.js',
    'file//extension/media/app.js',
  ])('rejects %s before reaching the file service', async path => {
    const readFile = vi.fn();
    const files = { readFile } as unknown as IFileService;
    expect(await loadWebviewResource(files, '/webview/vscode-resource/' + path, [root], signal)).toEqual({ status: 401 });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([
    [FileSystemProviderErrorCode.FileNotFound, 404],
    [FileSystemProviderErrorCode.FileTooLarge, 413],
  ])('translates file service error %s to HTTP %s', async (code, status) => {
    const readFile = vi.fn().mockRejectedValue(new FileSystemProviderError('test', code));
    const files = { readFile } as unknown as IFileService;
    expect(await loadWebviewResource(files, '/webview/vscode-resource/https/example.test%3A5173/extension/media/app.js',
      [root], signal)).toEqual({ status });
  });

  it('rejects encoded path separators before reconstructing a resource URL', () => {
    expect(() => asWebviewUri(origin, URI.parse('https://example.test/a%2fb'))).toThrow('encoded path separator');
  });
});
