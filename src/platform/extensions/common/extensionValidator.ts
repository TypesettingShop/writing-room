import type { IExtensionManifest, IExtensionMessage } from './extensions.js';

/** A publisher or extension name, as vsce accepts it. */
export const identifierPart = /^[a-z\d][a-z\d-]*$/i;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateExtensionManifest(input: unknown, resolveResource: (path: string) => unknown): {
  manifest?: IExtensionManifest;
  messages: IExtensionMessage[];
} {
  const messages: IExtensionMessage[] = [];
  const extensionId = isRecord(input) && nonemptyString(input.publisher) && nonemptyString(input.name)
    ? (input.publisher + '.' + input.name).toLowerCase() : '<unknown extension>';
  const report = (path: string, message: string, invalidResource?: boolean) =>
    messages.push({ extensionId, severity: 'error', path, message, invalidResource });

  if (!isRecord(input)) {
    report('$', 'Expected a manifest object.');
    return { messages };
  }

  for (const key of ['name', 'publisher', 'version'] as const) {
    const value = input[key];
    if (typeof value !== 'string' || !(key === 'version' ? versionPattern : identifierPart).test(value)) {
      report(key, `Expected a valid extension ${key}.`);
    }
  }
  for (const key of ['browser', 'icon'] as const) {
    const value = input[key];
    if (value !== undefined && (!nonemptyString(value) || !resolveResource(value))) {
      report(key, 'Expected a path inside the extension directory.', true);
    }
  }
  if (input.displayName !== undefined && !nonemptyString(input.displayName)) {
    report('displayName', 'Expected a nonempty string.');
  }
  if (input.activationEvents !== undefined
    && (!Array.isArray(input.activationEvents) || !input.activationEvents.every(nonemptyString))) {
    report('activationEvents', 'Expected an array of event names.');
  }
  if (input.contributes !== undefined && !isRecord(input.contributes)) {
    report('contributes', 'Expected a contribution object.');
  }
  if (messages.length) {
    return { messages };
  }
  return { manifest: input as unknown as IExtensionManifest, messages };
}

type Version = readonly [major: number, minor: number, patch: number];

function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Checks the engines.vscode range against a stable API version by VS Code's rules: a part may be
 * `x`, a prerelease suffix such as `-insider` is allowed, `^0.y.z` frees only the patch, and a range
 * below 1.0.0 that is not an exact version accepts every 1.x release.
 */
export function isValidExtensionVersion(version: string, range: string): boolean {
  const current = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/.exec(version);
  if (!current) {
    return false;
  }
  const actual: Version = [Number(current[1]), Number(current[2]), Number(current[3])];
  const requested = range.trim();
  if (requested === '*') {
    return true;
  }
  const match = /^(\^|>=)?(\d+|x)\.(\d+|x)\.(\d+|x)(?:-.*)?$/i.exec(requested);
  if (!match) {
    return false;
  }
  const [, operator, ...parts] = match;
  let desired = parts.map(part => part.toLowerCase() === 'x' ? 0 : Number(part)) as unknown as Version;
  if (operator === '>=') {
    return compareVersions(actual, desired) >= 0;
  }
  let mustEqual = parts.map(part => part.toLowerCase() !== 'x');
  if (operator === '^') {
    mustEqual = desired[0] === 0 ? [mustEqual[0], mustEqual[1], false] : [mustEqual[0], false, false];
  }
  if (actual[0] === 1 && desired[0] === 0 && mustEqual.includes(false)) {
    desired = [1, 0, 0];
    mustEqual = [true, false, false];
  }
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== desired[index]) {
      return actual[index] > desired[index] && !mustEqual[index];
    }
  }
  return true;
}
