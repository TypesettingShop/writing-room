import type { IncomingMessage } from 'node:http';

export type Authenticate = (request: IncomingMessage) => string | undefined | Promise<string | undefined>;

export const devUserId = '00000000-0000-4000-8000-0000000000de';
export const devAuthenticate: Authenticate = () => devUserId;
