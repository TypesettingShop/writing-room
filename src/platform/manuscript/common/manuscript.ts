export type ManuscriptNodeKind = 'part' | 'chapter' | 'document';

interface ManuscriptNodeType {
  readonly id: ManuscriptNodeKind;
  readonly container: boolean;
  readonly allowedParents: readonly (ManuscriptNodeKind | null)[];
  readonly numbered: boolean;
  readonly matter: 'body';
  readonly hideable: boolean;
}

export const manuscriptNodeTypes: Readonly<Record<ManuscriptNodeKind, ManuscriptNodeType>> = {
  part: { id: 'part', container: true, allowedParents: [null], numbered: true, matter: 'body', hideable: false },
  chapter: { id: 'chapter', container: true, allowedParents: [null, 'part'], numbered: true, matter: 'body', hideable: false },
  document: { id: 'document', container: false, allowedParents: [null, 'part', 'chapter'], numbered: false, matter: 'body', hideable: false },
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ManuscriptMetadata = { [key: string]: JsonValue };

export interface ManuscriptWork {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ManuscriptNode {
  id: string;
  parentId: string | null;
  kind: ManuscriptNodeKind;
  title: string;
  position: number;
  metadata: ManuscriptMetadata;
  createdAt: number;
  updatedAt: number;
}

export interface ManuscriptTree {
  revision: number;
  nodes: ManuscriptNode[];
}

export interface DocumentStat {
  mtime: number;
  size: number;
}

export interface ManuscriptDocument extends DocumentStat {
  content: string;
}

export const manuscriptLimits = {
  title: 200,
  nodes: 10_000,
  metadata: 64 * 1024,
  workMetadata: 16 * 1024 * 1024,
  document: 8 * 1024 * 1024,
} as const;

const errorMessages = {
  not_found: 'Manuscript resource not found.',
  conflict: 'The manuscript tree has changed.',
  precondition_failed: 'The manuscript document has changed.',
  invalid: 'Invalid manuscript input.',
  too_large: 'Manuscript input exceeds the size limit.',
  limit: 'The work has reached the node limit.',
  unauthorized: 'Sign-in is required.',
} as const;
export type ManuscriptStoreErrorCode = keyof typeof errorMessages;

export function isManuscriptStoreErrorCode(value: unknown): value is ManuscriptStoreErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorMessages, value);
}

export class ManuscriptStoreError extends Error {
  readonly code: ManuscriptStoreErrorCode;
  readonly currentRevision?: number;

  constructor(code: ManuscriptStoreErrorCode, currentRevision?: number) {
    super(errorMessages[code]);
    this.name = 'ManuscriptStoreError';
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

export function isManuscriptId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function isManuscriptNodeKind(value: unknown): value is ManuscriptNodeKind {
  return typeof value === 'string' && Object.hasOwn(manuscriptNodeTypes, value);
}

export function isManuscriptRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function checkRevision(current: number, expected: number): void {
  if (!isManuscriptRevision(expected)) {
    throw new ManuscriptStoreError('invalid');
  }
  if (current !== expected) {
    throw new ManuscriptStoreError('conflict', current);
  }
}

// PostgreSQL text and the UTF-8 wire format must preserve every accepted string.
const invalidText = /[\x00\uD800-\uDFFF]/u;

export function normalizeManuscriptTitle(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== 'string' || invalidText.test(value) || /[\x01-\x1f\x7f-\x9f\u2028\u2029]/.test(value)) {
    throw new ManuscriptStoreError('invalid');
  }
  const title = value.trim().normalize('NFC');
  if ((!allowEmpty && !title) || [...title].length > manuscriptLimits.title) {
    throw new ManuscriptStoreError('invalid');
  }
  return title;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeManuscriptMetadata(value: unknown): ManuscriptMetadata {
  if (!isRecord(value)) {
    throw new ManuscriptStoreError('invalid');
  }
  let json: string;
  try {
    json = JSON.stringify(value, (key, entry: unknown) => {
      if (invalidText.test(key) || (typeof entry === 'string' && invalidText.test(entry)) ||
        (typeof entry === 'number' && !Number.isFinite(entry)) ||
        (entry !== null && !['boolean', 'string', 'number', 'object'].includes(typeof entry))) {
        throw new ManuscriptStoreError('invalid');
      }
      return entry;
    });
  } catch {
    throw new ManuscriptStoreError('invalid');
  }
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new ManuscriptStoreError('invalid');
  }
  if (utf8Size(json) > manuscriptLimits.metadata) {
    throw new ManuscriptStoreError('too_large');
  }
  return parsed as ManuscriptMetadata;
}

// Count UTF-8 bytes without allocating a second copy of a document in the store.
export function utf8Size(value: string): number {
  let size = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    size += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return size;
}

export function documentSize(content: string): number {
  if (typeof content !== 'string' || invalidText.test(content)) {
    throw new ManuscriptStoreError('invalid');
  }
  const size = utf8Size(content);
  if (size > manuscriptLimits.document) {
    throw new ManuscriptStoreError('too_large');
  }
  return size;
}

// Keep in sync with etag() in files/common/files.ts.
export function documentEtag(mtime: number, size: number): string {
  return mtime.toString(29) + size.toString(31);
}

export function checkDocumentEtag(stat: DocumentStat, expectedEtag?: string): void {
  if (expectedEtag !== undefined && documentEtag(stat.mtime, stat.size) !== expectedEtag) {
    throw new ManuscriptStoreError('precondition_failed');
  }
}
