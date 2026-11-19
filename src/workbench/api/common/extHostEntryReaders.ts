import { fetchBoundedResource } from '../../../base/parts/request/common/boundedFetch.js';
import { extensionResourceLimits, registerExtensionEntryReader } from '../../services/extensions/common/extensionResources.js';
import type { ExtensionEntryReader } from '../../services/extensions/common/extensionResources.js';

const boundFetch = globalThis.fetch?.bind(globalThis);
const fetchEntry: ExtensionEntryReader = async (entry, signal) => {
  const { bytes } = await fetchBoundedResource(entry.toString(), {
    limit: extensionResourceLimits.entry, signal, request: boundFetch,
  });
  return bytes;
};

registerExtensionEntryReader('http', fetchEntry);
registerExtensionEntryReader('https', fetchEntry);
