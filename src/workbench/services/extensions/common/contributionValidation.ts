import { ThemeIcon } from '../../../../base/common/themables.js';
import { isRecord, nonemptyString } from '../../../../platform/extensions/common/extensionValidator.js';
import { Parser } from '../../../../platform/contextkey/common/contextkey.js';
import type { ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { resolveExtensionResource } from './extensionResources.js';
import type { IExtensionPointUser } from './extensionsRegistry.js';

export function contributionEntries(value: unknown, path: string, user: IExtensionPointUser<unknown>): unknown[] {
  if (!Array.isArray(value)) {
    user.collector.error(path, 'Expected an array of contributions.');
    return [];
  }
  return value;
}

export function contributionRecord<T>(
  value: unknown, path: string, user: IExtensionPointUser<unknown>,
  required: readonly string[], optional: readonly string[] = [],
): T | undefined {
  if (!isRecord(value)) {
    user.collector.error(path, 'Expected a contribution object.');
    return undefined;
  }
  for (const name of required) {
    if (!nonemptyString(value[name])) {
      user.collector.error(path + '.' + name, 'Expected a nonempty string.');
      return undefined;
    }
  }
  for (const name of optional) {
    const field = value[name];
    if (field !== undefined && typeof field !== 'string') {
      user.collector.error(path + '.' + name, 'Expected a string.');
      return undefined;
    }
  }
  return value as T;
}

export function contributionWhen(
  when: string | undefined, path: string, user: IExtensionPointUser<unknown>,
): ContextKeyExpression | undefined | false {
  if (!when?.trim()) {
    return undefined;
  }
  const parser = new Parser();
  const expression = parser.parse(when);
  if (!expression) {
    user.collector.error(path, parser.parsingErrors.join(' '));
    return false;
  }
  return expression;
}

export function contributionIcon(
  icon: string, path: string, user: IExtensionPointUser<unknown>,
): string | URL | undefined {
  if (ThemeIcon.fromString(icon)) {
    return icon;
  }
  const resource = resolveExtensionResource(user.description, icon);
  if (!resource) {
    user.collector.error(path, 'Expected a codicon or a path inside the extension directory.', true);
  }
  return resource;
}
