export class ResourceRequestError extends Error {}

interface BoundedFetchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly request?: typeof fetch;
  readonly contentTypePrefix?: string;
}

export async function fetchBoundedResource(
  url: string | URL,
  { limit, signal, request = fetch, contentTypePrefix }: BoundedFetchOptions,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  let response: Response;
  try {
    response = await request(url, {
      mode: 'cors', credentials: 'omit', redirect: 'error', signal: requestSignal,
    });
  } catch (cause) {
    throw new ResourceRequestError('Could not fetch the resource.', { cause });
  }
  const contentType = response.headers.get('Content-Type') ?? '';
  const tooLarge = () => new Error(`Response exceeds ${limit} bytes.`);
  try {
    if (!response.ok || response.redirected) {
      throw new Error(`HTTP ${response.status}`);
    }
    if (contentTypePrefix && !contentType.toLowerCase().startsWith(contentTypePrefix)) {
      throw new Error('Unsupported resource content type.');
    }
    if (Number(response.headers.get('Content-Length')) > limit) {
      throw tooLarge();
    }
    requestSignal.throwIfAborted();
  } catch (error) {
    void response.body?.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > limit) {
          throw tooLarge();
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  requestSignal.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType };
}
