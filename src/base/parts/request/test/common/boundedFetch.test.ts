import { afterEach, expect, it, vi } from 'vitest';
import { fetchBoundedResource, ResourceRequestError, ResourceTooLargeError } from '../../common/boundedFetch.js';

afterEach(() => vi.useRealTimers());

const url = 'https://open-vsx.org/package';

it('cancels an unapproved redirect before taking a reader', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
  const getReader = vi.spyOn(body, 'getReader');
  const response = new Response(body);
  Object.defineProperty(response, 'url', { value: 'https://open-vsx.org.example/package' });
  const request = vi.fn<typeof fetch>(async () => response);
  await expect(fetchBoundedResource(url, { limit: 4, redirectHosts: ['open-vsx.org'], request }))
    .rejects.toBeInstanceOf(ResourceRequestError);
  expect(getReader).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
});

it('refuses even an approved redirect unless the caller opts into redirect handling', async () => {
  const request = vi.fn<typeof fetch>(async () => {
    const response = new Response('data');
    Object.defineProperties(response, { url: { value: url }, redirected: { value: true } });
    return response;
  });
  await expect(fetchBoundedResource(url, { limit: 4, request })).rejects.toThrow('HTTP 200');
  expect(request.mock.calls[0][1]?.redirect).toBe('error');
});

it('checks both the advertised length and the accumulated body size', async () => {
  const advertised = new Response('a', { headers: { 'Content-Length': '5' } });
  const getReader = vi.spyOn(advertised.body!, 'getReader');
  await expect(fetchBoundedResource(url, { limit: 4, request: async () => advertised })).rejects.toBeInstanceOf(ResourceTooLargeError);
  expect(getReader).not.toHaveBeenCalled();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel });
  await expect(fetchBoundedResource(url, { limit: 4, request: async () => new Response(body) })).rejects.toBeInstanceOf(ResourceTooLargeError);
  expect(cancel).toHaveBeenCalledOnce();
});

it('lets a progressing package run past 30 seconds and terminates a stalled transfer', async () => {
  vi.useFakeTimers();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel });
  const request = async () => new Response(body);
  const result = fetchBoundedResource(url, { limit: 4, request, idleTimeout: true });
  await vi.advanceTimersByTimeAsync(25_000);
  stream.enqueue(Uint8Array.of(1));
  await vi.advanceTimersByTimeAsync(25_000);
  stream.enqueue(Uint8Array.of(2));
  stream.close();
  expect((await result).bytes).toEqual(Uint8Array.of(1, 2));

  const stalled = new ReadableStream<Uint8Array>({ cancel });
  const failure = expect(fetchBoundedResource(url, { limit: 4, request: async () => new Response(stalled), idleTimeout: true }))
    .rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(30_000);
  await failure;
  expect(cancel).toHaveBeenCalledOnce();
});
