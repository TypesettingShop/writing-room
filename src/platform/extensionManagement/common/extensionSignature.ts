import { defaultZipLimits, ZipArchive } from '../../../base/common/zip.js';

export const signatureBundleLimit = 1024 * 1024;

export type ExtensionSignature =
  | { readonly state: 'unsigned' }
  | { readonly state: 'unverifiable' | 'verified'; readonly keyId: string };

const signatureLength = 64;
// DER SubjectPublicKeyInfo for id-Ed25519 (1.3.101.112), no parameters, followed by the 32-byte key.
const ed25519SpkiPrefix = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

function readEd25519PublicKey(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const pem = new TextDecoder().decode(bytes).trim();
  const match = /^-----BEGIN PUBLIC KEY-----\s+([a-z\d+/=\r\n]+)\s+-----END PUBLIC KEY-----$/i.exec(pem);
  if (!match) {
    throw new Error('Open VSX returned an invalid public key.');
  }
  const base64 = match[1].replace(/[\r\n]/g, '');
  if (!/^[A-Za-z0-9+/]{59}=$/.test(base64)) {
    // A 44-byte DER value has 59 data characters and one padding character.
    throw new Error('Open VSX returned an invalid Ed25519 public key.');
  }
  const key = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
  if (key.length !== 44 || ed25519SpkiPrefix.some((byte, index) => key[index] !== byte)) {
    throw new Error('Open VSX returned an invalid Ed25519 public key.');
  }
  return key;
}

export async function verifyExtensionSignature(
  vsix: Uint8Array<ArrayBuffer>,
  bundle: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer>,
  keyId: string,
  signal?: AbortSignal,
): Promise<ExtensionSignature> {
  signal?.throwIfAborted();
  if (bundle.byteLength > signatureBundleLimit) {
    throw new Error('The Open VSX signature bundle is too large.');
  }
  const archive = ZipArchive.open(bundle, {
    ...defaultZipLimits, maxTotalSize: signatureBundleLimit, maxEntrySize: signatureBundleLimit,
  });
  const entry = archive.entries.find(file => file.path === '.signature.sig');
  if (archive.warnings.length || entry?.size !== signatureLength) {
    throw new Error('The Open VSX signature bundle lacks a valid Ed25519 signature.');
  }
  const signature = await archive.read(entry, signal);
  const keyBytes = readEd25519PublicKey(publicKey);
  let verified: boolean;
  try {
    const key = await crypto.subtle.importKey('spki', keyBytes, 'Ed25519', false, ['verify']);
    signal?.throwIfAborted();
    verified = await crypto.subtle.verify('Ed25519', key, signature, vsix);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof DOMException && error.name === 'NotSupportedError') {
      return { state: 'unverifiable', keyId };
    }
    throw error;
  }
  signal?.throwIfAborted();
  if (!verified) {
    throw new Error('The Open VSX Ed25519 signature does not match the downloaded package.');
  }
  return { state: 'verified', keyId };
}
