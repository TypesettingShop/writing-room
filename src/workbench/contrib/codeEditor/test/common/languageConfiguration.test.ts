// @vitest-environment node
import { expect, test } from 'vitest';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { parseLanguageConfiguration, readLanguageConfiguration } from '../../common/languageConfigurationExtensionPoint.js';

function parse(json: unknown) {
  const messages: string[] = [];
  const unsupported: string[] = [];
  const configuration = parseLanguageConfiguration(json, message => messages.push(message), field => unsupported.push(field));
  return { configuration, messages, unsupported };
}

test('reads every field Monaco knows into its shape', () => {
  const { configuration, messages, unsupported } = parse({
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [['{', '}'], ['(', ')']],
    colorizedBracketPairs: [['(', ')']],
    autoClosingPairs: [['(', ')'], { open: '"', close: '"', notIn: ['string'] }],
    surroundingPairs: [['(', ')'], { open: '*', close: '*' }],
    autoCloseBefore: ';:.,=}])> \n\t',
    wordPattern: { pattern: '\\p{Alphabetic}+', flags: 'ug' },
    indentationRules: { increaseIndentPattern: '\\{$', decreaseIndentPattern: { pattern: '^\\}' } },
    onEnterRules: [{ beforeText: '^\\s*//', action: { indent: 'none', appendText: '// ' } }],
    folding: { offSide: true, markers: { start: '^\\s*<!--\\s*#?region\\b.*-->', end: '^\\s*<!--\\s*#?endregion\\b.*-->' } },
  });
  expect(messages).toEqual([]);
  expect(unsupported).toEqual([]);
  expect(configuration.comments).toEqual({ lineComment: '//', blockComment: ['/*', '*/'] });
  expect(configuration.autoClosingPairs).toEqual([{ open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }]);
  expect(configuration.surroundingPairs).toEqual([{ open: '(', close: ')' }, { open: '*', close: '*' }]);
  expect(configuration.indentationRules?.increaseIndentPattern.source).toBe('\\{$');
  expect(configuration.onEnterRules?.[0].action).toEqual({ indentAction: 0, appendText: '// ' });
  expect(configuration.folding?.offSide).toBe(true);
  expect(configuration.folding?.markers?.start.test('<!-- #region a -->')).toBe(true);
});

test('keeps the flags of a word pattern, which \\p{...} needs', () => {
  const { configuration } = parse({ wordPattern: { pattern: '(\\p{Alphabetic}|\\p{Number})+', flags: 'ug' } });
  expect(configuration.wordPattern?.flags).toBe('gu');
  expect('한글 word42'.match(configuration.wordPattern!)).toEqual(['한글', 'word42']);
});

test('drops only the entry whose regular expression does not compile', () => {
  const { configuration, messages } = parse({
    autoClosingPairs: [['(', ')']],
    wordPattern: '(',
    indentationRules: { increaseIndentPattern: '(', decreaseIndentPattern: '^\\}' },
    onEnterRules: [{ beforeText: '[', action: { indent: 'indent' } }, { beforeText: 'x', action: { indent: 'outdent' } }],
  });
  expect(configuration.autoClosingPairs).toEqual([{ open: '(', close: ')' }]);
  expect(configuration.wordPattern).toBeUndefined();
  expect(configuration.indentationRules).toBeUndefined();
  expect(configuration.onEnterRules?.map(rule => rule.action.indentAction)).toEqual([3]);
  expect(messages).toHaveLength(3);
  expect(messages[0]).toContain('`wordPattern`');
});

test('reports entries of the wrong shape and keeps the right ones', () => {
  const { configuration, messages } = parse({
    comments: { lineComment: 1, blockComment: ['<!--', '-->'] },
    brackets: [['{', '}'], ['('], 'x'],
    autoClosingPairs: [{ open: '[', close: ']', notIn: 'string' }, ['{', '}']],
    autoCloseBefore: 3,
    folding: 'yes',
  });
  expect(configuration.comments).toEqual({ blockComment: ['<!--', '-->'] });
  expect(configuration.brackets).toEqual([['{', '}']]);
  expect(configuration.autoClosingPairs).toEqual([{ open: '{', close: '}' }]);
  expect(configuration.autoCloseBefore).toBeUndefined();
  expect(configuration.folding).toBeUndefined();
  expect(messages).toHaveLength(6);
});

test('names the fields Monaco has no place for instead of dropping them silently', () => {
  const { configuration, unsupported } = parse({
    autoClosingPairs: [{ open: '(', close: ')', beforeText: '\\w$' }],
    $schema: 'x',
  });
  expect(configuration.autoClosingPairs).toEqual([{ open: '(', close: ')' }]);
  expect(unsupported.sort()).toEqual(['$schema', 'autoClosingPairs[].beforeText']);
});

test('a file that is not an object gives an empty configuration', () => {
  expect(parse([1, 2]).configuration).toEqual({});
  expect(parse([1, 2]).messages).toHaveLength(1);
});

test('reads through the file service with the resource limit, and accepts comments and trailing commas', async () => {
  const reads: { resource: string; size: number | undefined }[] = [];
  const files = {
    readFile: async (resource: URI, options?: { limits?: { size?: number } }) => {
      reads.push({ resource: resource.toString(), size: options?.limits?.size });
      return { value: new TextEncoder().encode('// comment\n{ "brackets": [["(", ")"],], }') };
    },
  } as unknown as IFileService;
  const warnings: string[] = [];
  const file = URI.parse('http://127.0.0.1:9/ext/language-configuration.json');
  const configuration = await readLanguageConfiguration(files, 'x', file, message => warnings.push(message));
  expect(configuration).toEqual({ brackets: [['(', ')']] });
  expect(reads).toEqual([{ resource: file.toString(), size: 8 * 1024 * 1024 }]);
  expect(warnings).toEqual([]);
});

test('a file that cannot be read or parsed gives an empty configuration and one warning', async () => {
  const failing = { readFile: async () => { throw new Error('File exceeds the size limit'); } } as unknown as IFileService;
  const broken = { readFile: async () => ({ value: new TextEncoder().encode('{ "brackets": ') }) } as unknown as IFileService;
  const file = URI.parse('http://127.0.0.1:9/ext/c.json');
  for (const files of [failing, broken]) {
    const warnings: string[] = [];
    expect(await readLanguageConfiguration(files, 'x', file, message => warnings.push(message))).toEqual({});
    expect(warnings).toHaveLength(1);
  }
});
