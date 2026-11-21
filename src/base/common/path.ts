/** POSIX path operations shared by the browser and the extension worker. */
export function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..' && segments.length && segments.at(-1) !== '..') {
      segments.pop();
    } else if (segment !== '..' || !absolute) {
      segments.push(segment);
    }
  }
  const joined = segments.join('/');
  return absolute ? '/' + joined : joined || '.';
}

export function join(...paths: string[]): string {
  const path = paths.filter(Boolean).join('/');
  const result = normalize(path);
  return path.endsWith('/') && result !== '/' ? result + '/' : result;
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash < 0 ? (path.startsWith('/') ? '/' : '.') : trimmed.slice(0, slash) || '/';
}

export function extname(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 && name !== '..' ? name.slice(dot) : '';
}

export function relative(from: string, to: string): string {
  const origin = normalize('/' + from).split('/').filter(Boolean);
  const target = normalize('/' + to).split('/').filter(Boolean);
  let common = 0;
  while (common < origin.length && origin[common] === target[common]) {
    common++;
  }
  return [...origin.slice(common).map(() => '..'), ...target.slice(common)].join('/');
}
