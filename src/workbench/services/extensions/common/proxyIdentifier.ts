export interface ProxyIdentifier<T> {
  readonly id: string;
  readonly type?: T;
}

export function createProxyIdentifier<T>(id: string): ProxyIdentifier<T> {
  return { id };
}
