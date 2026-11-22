import type { ServerResponse } from 'node:http';
import { ManuscriptStoreError, type ManuscriptStoreErrorCode } from '../../src/platform/manuscript/common/manuscript.js';

const statusByCode: Record<ManuscriptStoreErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  precondition_failed: 412,
  invalid: 400,
  too_large: 413,
  limit: 409,
  unauthorized: 401,
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

export function sendError(response: ServerResponse, error: unknown, logError: (message: string) => void): void {
  if (error instanceof ManuscriptStoreError) {
    sendJson(response, statusByCode[error.code], {
      error: { code: error.code, message: error.message, currentRevision: error.currentRevision },
    });
  } else if (error instanceof ApiError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
  } else {
    logError('Unexpected failure handling an API request.');
    sendJson(response, 500, { error: { code: 'internal', message: 'Internal server error.' } });
  }
}
