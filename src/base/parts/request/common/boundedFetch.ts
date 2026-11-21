export class ResourceRequestError extends Error {}

export class ResourceResponseError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

export class ResourceTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response exceeds ${limit} bytes.`);
  }
}

interface BoundedFetchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  readonly request?: typeof fetch;
  readonly contentTypePrefix?: string;
  readonly method?: 'GET' | 'HEAD';
  /** Enables Fetch redirects, then requires the final response host before reading any bytes. */
  readonly redirectHosts?: readonly string[];
  /** For large downloads, time out after 30 seconds without progress. */
  readonly idleTimeout?: boolean;
}

const timeoutMs = 30_000;

function isAllowedResponseUrl(requestUrl: URL, responseUrl: URL, hosts: readonly string[]): boolean {
  return hosts.includes(responseUrl.hostname) && !responseUrl.username && !responseUrl.password
    && (responseUrl.protocol === 'https:'
      || (requestUrl.protocol === 'http:' && responseUrl.protocol === 'http:'
        && (responseUrl.hostname === 'localhost' || responseUrl.hostname === '127.0.0.1')));
}

export async function fetchBoundedResource(
  url: string | URL,
  { limit, signal, request = fetch, contentTypePrefix, method, redirectHosts, idleTimeout }: BoundedFetchOptions,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string; headers: Headers; url: string }> {
  const idle = idleTimeout ? new AbortController() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimeout = () => {
    if (idle) {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException('The download stopped responding.', 'TimeoutError')), timeoutMs);
    }
  };
  const timeout = idle?.signal ?? AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
  try {
    restartTimeout();
    requestSignal.throwIfAborted();
    const requestUrl = redirectHosts ? new URL(url) : undefined;
    let response: Response;
    try {
      response = await request(url, {
        mode: 'cors', credentials: 'omit', redirect: redirectHosts ? 'follow' : 'error',
        signal: requestSignal, ...(method ? { method } : {}),
      });
    } catch (cause) {
      if (idle?.signal.aborted || signal?.aborted) {
        requestSignal.throwIfAborted();
      }
      throw new ResourceRequestError('Could not fetch the resource.', { cause });
    }
    restartTimeout();
    const contentType = response.headers.get('Content-Type') ?? '';
    try {
      if (redirectHosts && requestUrl
        && (!response.url || !isAllowedResponseUrl(requestUrl, new URL(response.url), redirectHosts))) {
        throw new ResourceRequestError('The download response came from an unapproved host or protocol.');
      }
      if (!response.ok || (!redirectHosts && response.redirected)) {
        throw new ResourceResponseError(response.status);
      }
      if (contentTypePrefix && !contentType.toLowerCase().startsWith(contentTypePrefix)) {
        throw new Error('Unsupported resource content type.');
      }
      if (method !== 'HEAD' && Number(response.headers.get('Content-Length')) > limit) {
        throw new ResourceTooLargeError(limit);
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
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      requestSignal.addEventListener('abort', cancelReader, { once: true });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          requestSignal.throwIfAborted();
          if (done) {
            break;
          }
          if (value.byteLength === 0) {
            continue;
          }
          size += value.byteLength;
          if (size > limit) {
            throw new ResourceTooLargeError(limit);
          }
          restartTimeout();
          chunks.push(value);
        }
      } catch (error) {
        cancelReader();
        throw error;
      } finally {
        requestSignal.removeEventListener('abort', cancelReader);
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
    return { bytes, contentType, headers: response.headers, url: response.url };
  } finally {
    clearTimeout(timer);
  }
}
