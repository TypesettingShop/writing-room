import { Schemas } from '../../../base/common/network.js';

const reserved = new Set<string>([...Object.values(Schemas), 'data', 'blob', 'vscode-webview']);

export function isExtensionFileSystemScheme(scheme: unknown): scheme is string {
  return typeof scheme === 'string' && /^[a-z][a-z\d+.-]*$/.test(scheme) && !reserved.has(scheme);
}

export function validateExtensionFileSystemScheme(scheme: string): void {
  if (typeof scheme !== 'string' || !/^[a-z][a-z\d+.-]*$/i.test(scheme)) {
    throw new Error(`Invalid URI scheme: ${scheme}`);
  }
  if (!isExtensionFileSystemScheme(scheme.toLowerCase())) {
    throw new Error(`scheme '${scheme}' is reserved`);
  }
}

export function duplicateProvider(scheme: string): Error {
  return new Error(`a provider for the scheme '${scheme}' is already registered`);
}
