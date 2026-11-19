// @vitest-environment node
import { expect, test, vi } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { FetchFileSystemProvider } from '../../browser/webWorkerFileSystemProvider.js';

const Code = FileSystemProviderErrorCode;
const resource = URI.parse('https://example.test/a%20b?key=value');
const limits = { limits: { size: 12 } };

test('enforces read-only access and a byte limit before requesting, then cancels a stream that overruns it', async () => {
  let sent = 0;
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 4;
      controller.enqueue(new Uint8Array(4));
    },
    cancel: cancelled,
  }, { highWaterMark: 0 });
  const request = vi.fn<typeof fetch>(async () => new Response(stream));
  const provider = new FetchFileSystemProvider(request);
  const service = new FileService();
  service.registerProvider('https', provider);
  try {
    await expect(service.writeFile(resource, new Uint8Array())).rejects.toMatchObject({ code: Code.NoPermissions });
    await expect(provider.readdir()).rejects.toMatchObject({ code: Code.Unavailable });
    await expect(provider.delete()).rejects.toMatchObject({ code: Code.NoPermissions });
    await expect(service.readFile(resource)).rejects.toMatchObject({ code: Code.NoPermissions });
    expect(request).not.toHaveBeenCalled();
    await expect(service.readFile(resource, limits)).rejects.toMatchObject({ code: Code.FileTooLarge });
    expect(request).toHaveBeenCalledWith(new URL('https://example.test/a%20b?key=value'), expect.objectContaining({
      mode: 'cors', credentials: 'omit', redirect: 'error',
    }));
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(sent).toBe(16);
  } finally {
    service.dispose();
  }
});

test('maps rejected CORS or redirect requests and HTTP status without hanging', async () => {
  const request = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('CORS'))
    .mockResolvedValueOnce(Object.defineProperty(new Response('redirect'), 'redirected', { value: true }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': '100' } }));
  const provider = new FetchFileSystemProvider(request);
  await expect(provider.readFile(resource, limits)).rejects.toMatchObject({ code: Code.Unavailable });
  await expect(provider.readFile(resource, limits)).rejects.toMatchObject({ code: Code.Unavailable });
  await expect(provider.readFile(resource, limits)).rejects.toMatchObject({ code: Code.FileNotFound });
  await expect(provider.stat(resource)).resolves.toMatchObject({ size: 100 });
  expect(request.mock.calls[3][1]?.method).toBe('HEAD');
});
