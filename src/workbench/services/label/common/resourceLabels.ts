import { Emitter, type Event } from '../../../../base/common/event.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';

interface ResourceLabelProvider {
  getName(resource: URI): string | undefined;
  getDescription(resource: URI): string | undefined;
  readonly onDidChange?: Event<void>;
}

const providers = new Map<string, ResourceLabelProvider>();
const changed = new Emitter<string>();

export const onDidChangeResourceLabels = changed.event;

export function resourceLabelProvider(scheme: string): ResourceLabelProvider | undefined {
  return providers.get(scheme);
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
