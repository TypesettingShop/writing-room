import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (trustProxy && typeof forwarded === 'string') {
    // The trusted immediate proxy appends the address it actually saw.
    const nearest = forwarded.slice(forwarded.lastIndexOf(',') + 1).trim();
    // Some proxies append the port too ("192.0.2.1:5678", "[2001:db8::1]:5678").
    const address = /^\[([^\]]+)\]:\d+$/.exec(nearest)?.[1] ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(nearest)?.[1] ?? nearest;
    if (isIP(address)) {
      return address;
    }
  }
  return request.socket.remoteAddress ?? '';
}

/** Rate-limit neighboring IPv6 addresses together and normalize IPv4-mapped addresses. */
export function clientAddressKey(request: IncomingMessage, trustProxy: boolean): string {
  const address = clientIp(request, trustProxy);
  if (isIP(address) !== 6) {
    return address;
  }
  const ipv6 = new URL('http://[' + address.split('%', 1)[0] + ']/').hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ipv6);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }

  const [head, tail] = ipv6.split('::');
  const left = head ? head.split(':') : [];
  if (tail !== undefined) {
    const right = tail ? tail.split(':') : [];
    left.push(...Array<string>(8 - left.length - right.length).fill('0'), ...right);
  }
  return left.slice(0, 4).join(':') + '::/64';
}
