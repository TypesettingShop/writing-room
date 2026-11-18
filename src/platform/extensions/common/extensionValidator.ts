import type { IExtensionManifest, IExtensionMessage } from './extensions.js';

const identifierPart = /^[a-z\d][a-z\d-]*$/i;
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
