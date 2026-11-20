import { boundExtensionHostLogLine } from './extHost.protocol.runtime.js';
import type { MainThreadRuntimeShape } from './extHost.protocol.runtime.js';
import { formatLogArguments, logTimestamp } from './extHostOutput.js';

// Extension code shares this realm and can replace the globals.
const NativeError = Error;
const NativeAggregateError = AggregateError;

function formatError(error: unknown, depth = 0): string {
  try {
    if (!(error instanceof NativeError)) {
      return formatLogArguments([error]);
    }
    const stack = error.stack;
    const message = typeof stack === 'string' && stack ? stack : String(error);
    if (depth < 2 && error instanceof NativeAggregateError && Array.isArray(error.errors)) {
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
  void main.$logExtensionHost(boundExtensionHostLogLine(line + '\n')).catch(() => {});
}
