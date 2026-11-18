export interface UriComponents {
  readonly scheme: string;
  readonly authority?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
}

// RFC 3986, appendix B.
const uriPattern = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;

/**
 * A resource identifier. Unlike VS Code's `URI` this one does not percent-encode: it keeps the
 * components as given and `toString` joins them, which is enough for the generated resources
 * (`untitled:Untitled-1`) the workbench has in v0.1.0.
 */
export class URI implements Required<UriComponents> {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
  ) {}

  static from(components: UriComponents): URI {
    if (!/^[a-z][\w+.-]*$/i.test(components.scheme)) {
      throw new Error(`Invalid URI scheme: ${components.scheme}`);
    }
    const { scheme, authority = '', path = '', query = '', fragment = '' } = components;
    // Without percent-encoding these would print as a different URI than the one they describe.
    if (/[/?#]/.test(authority) || /[?#]/.test(path) || query.includes('#')
      || (authority && path && !path.startsWith('/')) || (!authority && path.startsWith('//'))) {
      throw new Error(`Invalid URI components: ${JSON.stringify(components)}`);
    }
    return new URI(scheme, authority, path, query, fragment);
  }

  static parse(value: string): URI {
    const match = uriPattern.exec(value);
    if (!match?.[1]) {
      throw new Error(`Invalid URI: ${value}`);
    }
    return URI.from({ scheme: match[1], authority: match[2], path: match[3], query: match[4], fragment: match[5] });
  }

  static isUri(value: unknown): value is URI {
    return value instanceof URI;
  }

  with(change: Partial<UriComponents>): URI {
    return URI.from({ ...this, ...change });
  }

  toString(): string {
    return this.scheme + ':'
      + (this.authority ? '//' + this.authority : '')
      + this.path
      + (this.query ? '?' + this.query : '')
      + (this.fragment ? '#' + this.fragment : '');
  }

  toJSON(): UriComponents {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment };
  }
}
