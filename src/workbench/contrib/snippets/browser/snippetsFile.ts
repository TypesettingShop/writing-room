import { parseJSONC } from '../../../../base/common/jsonc.js';
import { isRecord } from '../../../../platform/extensions/common/extensionValidator.js';

/** A file holds at most this many snippets; the rest are left out. */
export const MAX_SNIPPETS_PER_FILE = 5_000;

/** One snippet under one prefix: a snippet with several prefixes gives one of these per prefix. */
export interface ISnippet {
  /** The key the file gives it, such as "Insert bold text". */
  readonly name: string;
  readonly prefix: string;
  /** The body in snippet syntax: tab stops, placeholders, choices and variables. */
  readonly body: string;
  readonly description?: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Parses a snippet file (`.code-snippets` or `.json`, JSON with comments and trailing commas) as VS Code's
 * `SnippetFile` does for an extension's language snippets: each entry has a `prefix` (a string or an
 * array of strings), a `body` (a string or an array of lines) and an optional `description`. An entry of
 * another shape is left out and reported; the others stay.
 */
export function parseSnippetFile(text: string, report: (message: string) => void): ISnippet[] {
  const json = parseJSONC(text);
  if (!isRecord(json)) {
    report(json === undefined ? 'is not valid JSON.' : 'expected an object of snippets.');
    return [];
  }
  const snippets: ISnippet[] = [];
  let entries = 0;
  for (const [name, entry] of Object.entries(json)) {
    if (++entries > MAX_SNIPPETS_PER_FILE) {
      report(`has more than ${MAX_SNIPPETS_PER_FILE} snippets; the rest are left out.`);
      break;
    }
    if (!isRecord(entry)) {
      report(`snippet '${name}' is not an object.`);
      continue;
    }
    const { prefix, body, description } = entry;
    const prefixes = typeof prefix === 'string' ? [prefix] : isStringArray(prefix) ? prefix : undefined;
    const text = typeof body === 'string' ? body : isStringArray(body) ? body.join('\n') : undefined;
    if (!prefixes || text === undefined) {
      report(`snippet '${name}' needs a \`prefix\` (a string or strings) and a \`body\` (a string or lines).`);
      continue;
    }
    const detail = typeof description === 'string' ? description : isStringArray(description) ? description.join('\n') : undefined;
    for (const value of prefixes) {
      snippets.push({ name, prefix: value, body: text, description: detail });
    }
  }
  return snippets;
}
