import { FileSystemProviderError, FileSystemProviderErrorCode, FileType } from '../../../platform/files/common/files.js';
import type { FileStatDto } from './extHost.protocol.fileSystem.js';

const fileTypes: ReadonlySet<number> = new Set([
  FileType.Unknown, FileType.File, FileType.Directory, FileType.SymbolicLink,
  FileType.File | FileType.SymbolicLink, FileType.Directory | FileType.SymbolicLink,
]);

function isFileType(type: unknown): type is FileType {
  return typeof type === 'number' && fileTypes.has(type);
}

export function fileProviderStat(value: FileStatDto): FileStatDto {
  if (!value || !isFileType(value.type) || !Number.isFinite(value.ctime) || !Number.isFinite(value.mtime)
    || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new FileSystemProviderError('Invalid file stat from the extension provider.', FileSystemProviderErrorCode.Unknown);
  }
  const { type, ctime, mtime, size, permissions } = value;
  return { type, ctime, mtime, size, ...(permissions === 1 ? { permissions } : {}) };
}

export function fileProviderDirectory(entries: readonly [string, FileType][]): readonly [string, FileType][] {
  if (!Array.isArray(entries) || entries.some(entry =>
    !Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[0] || entry[0] === '.' || entry[0] === '..'
    || /[/\\\x00-\x1f\x7f-\x9f]/.test(entry[0]) || !isFileType(entry[1]))) {
    throw new FileSystemProviderError('Invalid directory listing from the extension provider.', FileSystemProviderErrorCode.Unknown);
  }
  return entries.map(([name, type]): [string, FileType] => [name, type]);
}
