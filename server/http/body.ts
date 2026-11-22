import type { IncomingMessage } from 'node:http';
import { isRecord, manuscriptLimits, ManuscriptStoreError } from '../../src/platform/manuscript/common/manuscript.js';
import { ApiError } from './errors.js';

const jsonLimit = 1024 * 1024;

async function readText(request: IncomingMessage, mediaType: string, limit: number): Promise<string> {
  if (request.destroyed) {
    throw new ManuscriptStoreError('invalid');
  }
  const type = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type !== mediaType) {
    throw new ApiError(415, 'unsupported_media_type', 'Unsupported request content type.');
  }
  if (Number(request.headers['content-length']) > limit) {
    throw new ManuscriptStoreError('too_large');
  }
  // Reject an oversized stream without destroying its socket before the response can send a 413.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  return new Promise((resolve, reject) => {
    let size = 0;
    const text: string[] = [];
    function stop(error: ManuscriptStoreError): void {
      request.pause();
      request.off('data', onData);
      request.off('end', onEnd);
      reject(error);
    }
    function onData(chunk: Buffer): void {
      size += chunk.length;
      if (size > limit) {
        stop(new ManuscriptStoreError('too_large'));
        return;
      }
      try {
        text.push(decoder.decode(chunk, { stream: true }));
      } catch {
        stop(new ManuscriptStoreError('invalid'));
      }
    }
    function onEnd(): void {
      try {
        text.push(decoder.decode());
        resolve(text.join(''));
      } catch {
        reject(new ManuscriptStoreError('invalid'));
      }
    }
    request.once('error', () => stop(new ManuscriptStoreError('invalid')));
    request.on('data', onData);
    request.once('end', onEnd);
  });
}

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(request, 'application/json', jsonLimit);
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new ManuscriptStoreError('invalid');
  }
  if (!isRecord(result)) {
    throw new ManuscriptStoreError('invalid');
  }
  return result;
}

export function readMarkdown(request: IncomingMessage): Promise<string> {
  return readText(request, 'text/markdown', manuscriptLimits.document);
}
