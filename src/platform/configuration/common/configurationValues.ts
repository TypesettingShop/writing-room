/** Helpers for setting values: JSON data read from settings.json, manifests and the extension host. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Structural equality of JSON values; object key order does not matter. */
export function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equals(value, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equals(a[key], b[key]));
}

/** A copy the caller may change without changing the original. */
export function deepClone<T>(value: T): T {
  return value !== null && typeof value === 'object' ? structuredClone(value) : value;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Whether `value` can be stored in settings.json and read back as itself: JSON data without cycles,
 * functions, symbols, `undefined` or non-finite numbers.
 */
export function isJSONValue(value: unknown, ancestors = new Set<object>()): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'object': {
      if (value === null) {
        return true;
      }
      if (ancestors.has(value) || !(Array.isArray(value) || isPlainObject(value))) {
        return false;
      }
      ancestors.add(value);
      const result = Array.isArray(value)
        ? Array.from(value, entry => entry).every(entry => isJSONValue(entry, ancestors))
        : Object.values(value).every(entry => isJSONValue(entry, ancestors));
      ancestors.delete(value);
      return result;
    }
    default:
      return false;
  }
}
