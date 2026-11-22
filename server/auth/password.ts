import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const parameters = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const keyLength = 64;
const saltLength = 16;
const format = 'scrypt$15$8$3';
const dummySalt = randomBytes(saltLength);
const dummyKey = randomBytes(keyLength);

// scrypt runs on the libuv threadpool, which dns.lookup and fs share. Leave one thread for them.
const maxActiveHashes = Math.min(4, Math.max(1, Math.floor((Number(process.env.UV_THREADPOOL_SIZE) || 4) - 1)));
const maxWaiters = 16;
// A permit goes straight to the next waiter so new requests cannot jump the queue.
let activeHashes = 0;
const waiters: (() => void)[] = [];

export class PasswordWorkQueueFull extends Error {}

async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= maxActiveHashes) {
    if (waiters.length >= maxWaiters) {
      throw new PasswordWorkQueueFull('Password work queue is full.');
    }
    await new Promise<void>(resolve => waiters.push(resolve));
  } else {
    activeHashes++;
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, keyLength, parameters, (error, key) => {
        if (error) {
          reject(error);
        } else {
          resolve(key);
        }
      });
    });
  } finally {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      activeHashes--;
    }
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltLength);
  const key = await deriveKey(password, salt);
  return [format, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, encoded: string | undefined): Promise<boolean> {
  const parts = encoded?.split('$') ?? [];
  // A new format can supply its own parameters here when password rehashing is added.
  const knownFormat = parts.length === 6 && parts.slice(0, 4).join('$') === format;
  const salt = knownFormat ? Buffer.from(parts[4], 'base64') : dummySalt;
  const key = knownFormat ? Buffer.from(parts[5], 'base64') : dummyKey;
  const usable = knownFormat && salt.length === saltLength && key.length === keyLength;
  const actual = await deriveKey(password, usable ? salt : dummySalt);
  const matches = timingSafeEqual(actual, usable ? key : dummyKey);
  return usable && matches;
}
