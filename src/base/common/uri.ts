import { Schemas } from './network.js';
import { join } from './path.js';

export interface UriComponents {
  readonly scheme: string;
  readonly authority?: string;
  readonly path?: string;
  readonly query?: string;
  readonly fragment?: string;
  /** Carries path ambiguity across structured cloning and RPC. */
  readonly hasEncodedPathSeparator?: boolean;
}

const uriPattern = /^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/;
const encodedSeparator = /%(?:25)*(?:2f|5c)/i;

function decode(value = ''): string {
  return value.replace(/(?:%[\da-fA-F]{2})+/g, run => {
    try {
      return decodeURIComponent(run);
    } catch {
      // Keep invalid bytes intact while decoding the valid characters around them.
      return run.replace(/%(?:[0-7][\da-f]|[cd][\da-f](?:%[89ab][\da-f])|e[\da-f](?:%[89ab][\da-f]){2}|f[0-4](?:%[89ab][\da-f]){3})/gi, sequence => {
        try { return decodeURIComponent(sequence); } catch { return sequence; }
      });
    }
  });
}

/** VS Code's `toString(true)` escapes only the characters that would end the component. */
function encodeMinimal(value: string): string {
  return value.replace(/[#?]/g, character => character === '#' ? '%23' : '%3F');
}

function encode(value: string, allowed = ''): string {
  return value.replace(/[^\w.~\-]/ug, character => {
    if (allowed.includes(character)) {
      return character;
    }
    return /[!'()*]/.test(character)
      ? '%' + character.charCodeAt(0).toString(16).toUpperCase()
      : encodeURIComponent(character);
  });
}

export class URI implements Required<UriComponents> {
  #originalQuery: string | undefined;
  /** The components never change, and equality checks and map keys format the same URI repeatedly. */
  #formatted: string | undefined;

  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string,
    readonly hasEncodedPathSeparator: boolean,
  ) {}

  static from(components: UriComponents, strict = false): URI {
    const { authority = '', query = '', fragment = '', hasEncodedPathSeparator = false } = components;
    const scheme = components.scheme || (strict ? '' : Schemas.file);
    let path = components.path ?? '';
    if (!/^\w[\w+.-]*$/.test(scheme)) {
      throw new Error(`Invalid URI scheme: ${scheme}`);
    }
    if ((scheme === Schemas.file || scheme === Schemas.http || scheme === Schemas.https) && !path.startsWith('/')) {
      path = '/' + path;
    }
    if ((authority && path && !path.startsWith('/')) || (!authority && path.startsWith('//'))) {
      throw new Error(`Invalid URI path: ${path}`);
    }
    return new URI(scheme, authority, path, query, fragment, hasEncodedPathSeparator === true);
  }

  static parse(value: string, strict = false): URI {
    const match = uriPattern.exec(value);
    if (!match || (strict && !match[1])) {
      throw new Error(`Invalid URI: ${value}`);
    }
    const [, scheme, authority, path, query, fragment] = match;
    const uri = URI.from({
      scheme, authority: decode(authority), path: decode(path), query: decode(query), fragment: decode(fragment),
      hasEncodedPathSeparator: encodedSeparator.test(path),
    }, strict);
    uri.#originalQuery = query;
    return uri;
  }

  static file(path: string): URI {
    const unc = /^\/\/([^/]+)(\/.*)?$/s.exec(path);
    return URI.from({ scheme: Schemas.file, authority: unc?.[1], path: unc ? unc[2] : path });
  }

  static joinPath(resource: URI, ...fragments: string[]): URI {
    if (!resource.path) {
      throw new Error('Cannot join a URI without a path');
    }
    return resource.with({ path: join(resource.path, ...fragments) });
  }

  static revive(value: URI | UriComponents): URI;
  static revive<T extends URI | UriComponents | undefined | null>(value: T): URI | Extract<T, undefined | null>;
  static revive(value: URI | UriComponents | undefined | null): URI | undefined | null {
    return value == null || URI.isUri(value) ? value : URI.from(value);
  }

  static isUri(value: unknown): value is URI {
    return value instanceof URI;
  }

  get fsPath(): string {
    if (this.scheme === Schemas.file && this.authority && this.path.length > 1) {
      return `//${this.authority}${this.path}`;
    }
    return this.path.replace(/^\/([a-z]):/i, (_, drive: string) => drive.toLowerCase() + ':');
  }

  /** HTTP query syntax preserves escaped delimiters from the parsed URL. */
  get encodedHttpQuery(): string {
    return this.#originalQuery ?? encodeURI(this.query).replaceAll('#', '%23');
  }

  with(change?: { [K in Exclude<keyof UriComponents, 'hasEncodedPathSeparator'>]?: UriComponents[K] | null }): URI {
    if (!change) {
      return this;
    }
    const resource = URI.from({
      scheme: change.scheme === undefined ? this.scheme : change.scheme ?? '',
      authority: change.authority === undefined ? this.authority : change.authority ?? '',
      path: change.path === undefined ? this.path : change.path ?? '',
      query: change.query === undefined ? this.query : change.query ?? '',
      fragment: change.fragment === undefined ? this.fragment : change.fragment ?? '',
      hasEncodedPathSeparator: this.hasEncodedPathSeparator,
    }, true);
    if (change.query === undefined) {
      resource.#originalQuery = this.#originalQuery;
    }
    return resource.scheme === this.scheme && resource.authority === this.authority && resource.path === this.path
      && resource.query === this.query && resource.fragment === this.fragment ? this : resource;
  }

  /** `skipEncoding` is the `vscode.Uri` option. As in VS Code, only the encoded form is cached. */
  toString(skipEncoding = false): string {
    return skipEncoding ? this.format(true) : this.#formatted ??= this.format(false);
  }

  private format(skipEncoding: boolean): string {
    const escape: (value: string, allowed?: string) => string = skipEncoding ? encodeMinimal : encode;
    let host = this.authority;
    let userInfo = '';
    const at = host.indexOf('@');
    if (at >= 0) {
      const credentials = host.slice(0, at);
      const colon = credentials.lastIndexOf(':');
      userInfo = (colon < 0 ? escape(credentials)
        : escape(credentials.slice(0, colon)) + ':' + escape(credentials.slice(colon + 1), '[]:')) + '@';
      host = host.slice(at + 1);
    }
    const path = /^https?$/i.test(this.scheme) ? this.path
      : this.path.replace(/^(\/?)([A-Z]):/, (_, slash: string, drive: string) => slash + drive.toLowerCase() + ':');

    return this.scheme + ':'
      + (this.authority || this.scheme === Schemas.file ? '//' + userInfo + escape(host.toLowerCase(), '[]:') : '')
      + escape(path, '/')
      + (this.query ? '?' + escape(this.query) : '')
      + (this.fragment ? '#' + (skipEncoding ? this.fragment : encode(this.fragment)) : '');
  }

  toJSON(): UriComponents & { $mid: 1 } {
    const { scheme, authority, path, query, fragment, hasEncodedPathSeparator } = this;
    return { $mid: 1, scheme, authority, path, query, fragment,
      ...(hasEncodedPathSeparator ? { hasEncodedPathSeparator } : {}) };
  }
}
