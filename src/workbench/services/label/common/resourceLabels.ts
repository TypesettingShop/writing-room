import { Emitter, Event } from '../../../../base/common/event.js';
import { basename } from '../../../../base/common/resources.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';

interface ResourceLabelProvider {
  getName(resource: URI): string | undefined;
  getDescription(resource: URI): string | undefined;
  readonly onDidChange?: Event<void>;
}

const providers = new Map<string, ResourceLabelProvider>();
const changed = new Emitter<string>();

export function onDidChangeResourceLabel(resource: URI): Event<string> {
  return Event.filter(changed.event, scheme => scheme === resource.scheme);
}

export function resourceDisplayName(resource: URI): string {
  return providers.get(resource.scheme)?.getName(resource) ?? (basename(resource) || resource.toString());
}

export function resourceLabelDescription(resource: URI): string | undefined {
  return providers.get(resource.scheme)?.getDescription(resource);
}

export function resourceLabelTitle(resource: URI): string | undefined {
  const provider = providers.get(resource.scheme);
  const name = provider?.getName(resource);
  return name ? [provider?.getDescription(resource), name].filter(Boolean).join(' / ') : undefined;
}

export function registerResourceLabelProvider(scheme: string, provider: ResourceLabelProvider): IDisposable {
  if (providers.has(scheme)) {
    throw new Error(`A resource label provider is already registered for ${scheme}.`);
  }
  providers.set(scheme, provider);
  const subscription = provider.onDidChange?.(() => changed.fire(scheme));
  changed.fire(scheme);
  return toDisposable(() => {
    subscription?.dispose();
    providers.delete(scheme);
    changed.fire(scheme);
  });
}
