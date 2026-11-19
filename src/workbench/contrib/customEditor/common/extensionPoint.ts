import { isRecord, nonemptyString } from '../../../../platform/extensions/common/extensionValidator.js';
import { ExtensionsRegistry } from '../../../services/extensions/common/extensionsRegistry.js';
import type { ExtensionPointContext, IExtensionPointUser } from '../../../services/extensions/common/extensionsRegistry.js';
import { customEditorContributions } from './customEditor.js';
import type { CustomEditorContributions, CustomEditorInfo, CustomEditorPriority } from './customEditor.js';

/** What a `priority` says; VS Code's `builtin` is taken as `default`, anything unknown is reported. */
function readPriority(value: unknown): CustomEditorPriority | undefined {
  switch (value) {
    case undefined:
    case 'default':
    case 'builtin':
      return 'default';
    case 'option':
      return 'option';
    default:
      return undefined;
  }
}

/**
 * Checks every extension's `contributes.customEditors` and puts the valid entries in `target`. A
 * `viewType` another extension took first is refused. Each editor adds the implicit
 * `onCustomEditor:<viewType>` activation event, as VS Code does.
 */
export function acceptCustomEditors(
  users: readonly IExtensionPointUser<readonly unknown[]>[],
  context: Pick<ExtensionPointContext, 'addActivationEvent'>,
  target: CustomEditorContributions = customEditorContributions,
) {
  const editors: CustomEditorInfo[] = [];
  for (const { description, value, collector } of users) {
    const extensionId = description.identifier.value;
    value.forEach((entry, index) => {
      const path = `contributes.customEditors[${index}]`;
      if (!isRecord(entry)) {
        collector.error(path, 'Expected a custom editor object.');
        return;
      }
      const { viewType, displayName, selector, priority } = entry;
      if (!nonemptyString(viewType)) {
        collector.error(path + '.viewType', "Expected 'viewType' to be a non-empty string.");
        return;
      }
      if (!nonemptyString(displayName)) {
        collector.error(path + '.displayName', "Expected 'displayName' to be a non-empty string.");
        return;
      }
      if (!Array.isArray(selector)) {
        collector.error(path + '.selector', "Expected 'selector' to be an array.");
        return;
      }
      const filenamePatterns: string[] = [];
      selector.forEach((item, at) => {
        if (isRecord(item) && nonemptyString(item.filenamePattern)) {
          filenamePatterns.push(item.filenamePattern);
        } else {
          collector.warn(`${path}.selector[${at}]`, "Expected an object with a non-empty 'filenamePattern'. The entry is ignored.");
        }
      });
      const read = readPriority(priority);
      if (!read) {
        collector.warn(path + '.priority', `Unknown priority '${String(priority)}'. 'default' is used.`);
      }
      if (editors.some(other => other.id === viewType)) {
        collector.error(path + '.viewType', `The custom editor '${viewType}' is already contributed.`);
        return;
      }
      editors.push({
        id: viewType, displayName, extensionId, filenamePatterns, priority: read ?? 'default',
        providerDisplayName: description.manifest.displayName ?? extensionId,
      });
      context.addActivationEvent(extensionId, 'onCustomEditor:' + viewType);
    });
  }
  return target.set(editors);
}

ExtensionsRegistry.registerExtensionPoint<readonly unknown[]>({
  name: 'customEditors',
  validate: (value): value is readonly unknown[] => Array.isArray(value),
  accept: (users, registrations, context) => registrations.add(acceptCustomEditors(users, context)),
});
