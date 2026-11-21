const NativeError = Error;
const errorToString = Error.prototype.toString;
const frameLocation = /^\s+at (?:.*? \((\S+):\d+:\d+\)|(?:async )?(\S+):\d+:\d+)$/;

/** Finds the first exact evaluated entry URL in a V8 stack. Unfamiliar stacks stay in the console. */
export function findExtensionErrorOwner(error: unknown, entries: ReadonlyMap<string, string>): string | undefined {
  try {
    if (!(error instanceof NativeError)) {
      return undefined;
    }
    const stack = error.stack;
    const header = errorToString.call(error) + '\n';
    if (typeof stack !== 'string' || !stack.startsWith(header)) {
      return undefined;
    }
    // Consume the whole header before reading frames. The error message itself can contain newlines.
    for (const frame of stack.slice(header.length).split('\n')) {
      const location = frameLocation.exec(frame);
      const owner = location && entries.get(location[1] ?? location[2]);
      if (owner) {
        return owner;
      }
    }
  } catch {
    // Custom stack and message getters can fail. Let the existing console path report the original reason.
  }
  return undefined;
}
