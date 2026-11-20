import { EXTENSION_HOST_LOG_LINE_LIMIT } from './extHost.protocol.runtime.js';
import type { MainThreadRuntimeShape } from './extHost.protocol.runtime.js';
import { formatLogArguments, logTimestamp } from './extHostOutput.js';

function formatError(error: unknown, depth = 0): string {
  try {
    if (!(error instanceof Error)) {
      return formatLogArguments([error]);
    }
    const stack = error.stack;
    const message = typeof stack === 'string' && stack ? stack : String(error);
    if (depth < 2 && error instanceof AggregateError && Array.isArray(error.errors)) {
      return message + error.errors.slice(0, 8).map(cause => '\n' + formatError(cause, depth + 1)).join('');
    }
    return message;
  } catch {
    // An extension can throw a value with custom or throwing formatting hooks.
    return '<unprintable error>';
  }
}

export function logExtensionHostError(
  main: MainThreadRuntimeShape, extensionId: string, message: string, error: unknown,
): void {
  const line = logTimestamp() + ' [error] [' + extensionId + '] ' + message + ' ' + formatError(error);
  void main.$logExtensionHost(line.slice(0, EXTENSION_HOST_LOG_LINE_LIMIT - 1) + '\n').catch(() => {});
}
