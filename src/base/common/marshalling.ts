import { URI } from './uri.js';
import type { UriComponents } from './uri.js';

const URI_MARKER = 1;
const MAX_DEPTH = 200;

/** Transfers the view's backing buffer, including other views of that buffer. */
export class TransferableBuffer {
  constructor(readonly bytes: Uint8Array) {}
}

/**
 * Copies the records along the way, applying `replace` first. With `copyInstances`, an instance of a
 * class that structured cloning would flatten to its own enumerable fields (a `Location` holding a
 * `Uri`, say) is flattened here instead, so the values inside it are replaced too. Built-in types,
 * such as dates, maps and typed arrays, are left to structured cloning.
 */
function transform(value: unknown, replace: (value: object) => object, copyInstances = false): unknown {
  const seen = new WeakMap<object, object>();

  function visit(value: unknown, depth: number): unknown {
    if (typeof value !== 'object' || value === null) {
      return value;
    }
    const previous = seen.get(value);
    if (previous) {
      return previous;
    }
    if (depth > MAX_DEPTH) {
      throw new RangeError('RPC data is nested too deeply.');
    }
    const replacement = replace(value);
    if (replacement !== value) {
      seen.set(value, replacement);
      return replacement;
    }

    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null
      && !(copyInstances && Object.prototype.toString.call(value) === '[object Object]')) {
      return value;
    }
    const result = array ? new Array(value.length) : {};
    seen.set(value, result);
    const entries = value as Record<string, unknown>;
    for (const key of Object.keys(entries)) {
      Object.defineProperty(result, key, {
        value: visit(entries[key], depth + 1), enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  }

  return visit(value, 0);
}

export function marshal(value: unknown): { value: unknown; transfer: ArrayBuffer[] } {
  const transfer = new Set<ArrayBuffer>();
  const data = transform(value, object => {
    if (object instanceof URI) {
      return { ...object.toJSON(), $mid: URI_MARKER };
    }
    if (object instanceof TransferableBuffer) {
      const bytes = object.bytes;
      if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) {
        throw new TypeError('Only Uint8Array views of ArrayBuffer can be transferred.');
      }
      transfer.add(bytes.buffer);
      return bytes;
    }
    return object;
  }, true);
  return { value: data, transfer: [...transfer] };
}

export function revive(value: unknown): unknown {
  return transform(value, object => {
    if (!Object.hasOwn(object, '$mid') || (object as { $mid: unknown }).$mid !== URI_MARKER) {
      return object;
    }
    const components = object as Partial<UriComponents>;
    if (typeof components.scheme !== 'string'
      || [components.authority, components.path, components.query, components.fragment]
        .some(field => field !== undefined && typeof field !== 'string')) {
      throw new TypeError('Invalid RPC URI components.');
    }
    return URI.from(components as UriComponents);
  });
}
