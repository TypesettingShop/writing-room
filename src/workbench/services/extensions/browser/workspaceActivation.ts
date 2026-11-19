import { parse } from '../../../../base/common/glob.js';
import { normalizeFileResource } from '../../../../platform/files/common/fileResource.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

export async function findWorkspaceActivation(
  files: IFileService, folders: readonly IWorkspaceFolder[], pattern: string, signal: AbortSignal,
): Promise<boolean> {
  if (!pattern || /[\\:\x00-\x1f\x7f]/.test(pattern) || pattern.startsWith('/') || pattern.split('/').includes('..')) {
    return false;
  }
  if (!/[*?\[{]/.test(pattern)) {
    for (const folder of folders) {
      if (signal.aborted) {
        return false;
      }
      if (await files.exists(normalizeFileResource(folder.toResource(pattern)))) {
        return !signal.aborted;
      }
    }
    return false;
  }

  const timeout = AbortSignal.timeout(7_000);
  const search = AbortSignal.any([timeout, signal]);
  const matcher = parse(pattern);
  return new Promise<boolean>((resolve, reject) => {
    const cancel = () => resolve(false);
    if (search.aborted) {
      cancel();
      return;
    }
    search.addEventListener('abort', cancel, { once: true });
    const visit = async () => {
      for (const folder of folders) {
        const pending = [folder.uri];
        const base = folder.uri.path + '/';
        while (pending.length && !search.aborted) {
          const stat = await files.resolve(pending.pop()!);
          for (const child of stat.children ?? []) {
            if (search.aborted) {
              return false;
            }
            if (matcher(child.resource.path.slice(base.length))) {
              return true;
            }
            if (child.isDirectory) {
              pending.push(child.resource);
            }
          }
        }
      }
      return false;
    };
    void visit().then(resolve, reject).finally(() => search.removeEventListener('abort', cancel));
  });
}
