export const extensionResourceLimits = {
  manifest: 256 * 1024,
  entry: 5 * 1024 * 1024,
  icon: 256 * 1024,
} as const;

export function resolveExtensionPath(location: string, path: string): URL | undefined {
  if (!path || path !== path.trim() || /[\\?#\u0000-\u001f\u007f]/.test(path)
    || path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return undefined;
  }
  try {
    const folder = new URL(location);
    if (!folder.pathname.endsWith('/')) {
      return undefined;
    }
    const segments: string[] = [];
    for (const segment of path.split('/')) {
      const decoded = decodeURIComponent(segment);
      if (/[\\/%\u0000-\u001f\u007f]/.test(decoded)) {
        return undefined;
      }
      if (decoded === '..') {
        if (!segments.length) {
          return undefined;
        }
        segments.pop();
      } else if (decoded && decoded !== '.') {
        segments.push(encodeURIComponent(decoded));
      }
    }
    if (!segments.length || path.endsWith('/')) {
      return undefined;
    }
    const url = new URL('./' + segments.join('/'), folder);
    return url.origin === folder.origin && url.pathname.startsWith(folder.pathname) ? url : undefined;
  } catch {
    return undefined;
  }
}
